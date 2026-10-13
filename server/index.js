import express from 'express';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, DATA_DIR } from './config.js';
import { zip } from './zip.js';
import { db, getSettings, setSettings, addEvent } from './db.js';
import { encrypt, verifyPassword, hashPassword, signSession, verifySession } from './crypto.js';
import { normalizeCookie, normalizeProxy, EarnAppClient } from './earnapp.js';
import { runCycle, startScheduler, syncState, requestSyncAll } from './sync.js';
import { summary, dailySeries, profitByMonth, deviceRanking, accountRanking, usageSeries, usageToday, usageMonthly } from './stats.js';
import { sendTelegram } from './telegram.js';
import { overview, report, scopeOptions } from './reports.js';

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '2mb' }));

const COOKIE = 'eam_session';
const setSession = (req, res, user) => res.setHeader('Set-Cookie',
  `${COOKIE}=${signSession(user.username, user.session_ver)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
const getToken = req => (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);

// ---------- Đăng nhập ----------
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Sai quá nhiều lần, thử lại sau 5 phút' });
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user.pw_hash)) {
    a.n++;
    if (a.n >= 5) { a.until = Date.now() + 5 * 60e3; a.n = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  attempts.delete(ip);
  setSession(req, res, user);
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const s = verifySession(getToken(req));
  const user = s && db.prepare('SELECT username, session_ver FROM users WHERE username = ?').get(s.user);
  // Phiên cũ (trước khi đổi mật khẩu / đăng xuất các thiết bị khác) không còn hiệu lực
  if (!user || user.session_ver !== s.ver) return res.status(401).json({ error: 'Chưa đăng nhập' });
  req.user = user.username;
  next();
});

app.get('/api/me', (req, res) => res.json({ username: req.user }));

app.post('/api/password', (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.user);
  if (!verifyPassword(String(current || ''), user.pw_hash)) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 6 ký tự' });
  // Đổi mật khẩu: đăng xuất mọi thiết bị khác, phiên hiện tại nhận token mới
  db.prepare('UPDATE users SET pw_hash = ?, session_ver = session_ver + 1 WHERE username = ?').run(hashPassword(next), req.user);
  setSession(req, res, db.prepare('SELECT * FROM users WHERE username = ?').get(req.user));
  res.json({ ok: true });
});

app.post('/api/logout-others', (req, res) => {
  db.prepare('UPDATE users SET session_ver = session_ver + 1 WHERE username = ?').run(req.user);
  setSession(req, res, db.prepare('SELECT * FROM users WHERE username = ?').get(req.user));
  res.json({ ok: true });
});

// ---------- Tổng quan ----------
app.get('/api/summary', (req, res) => {
  res.json({
    ...summary(),
    daily: dailySeries(Number(req.query.days) || 30),
    usage_daily: usageSeries(Number(req.query.days) || 30),
    sync: syncState,
    events: db.prepare(`SELECT e.*, COALESCE(a.label, a.email) AS account FROM events e LEFT JOIN accounts a ON a.id = e.account_id ORDER BY e.id DESC LIMIT 15`).all(),
  });
});

// ---------- Tổng quan & báo cáo (lọc theo acc / nhóm / khoảng thời gian) ----------
app.get('/api/overview', (req, res) => res.json(overview(req.query)));
app.get('/api/report', (req, res) => res.json(report(req.query)));
app.get('/api/scope', (req, res) => res.json(scopeOptions()));

// ---------- Tài khoản ----------
const ACCOUNT_LIST_SQL = `
  SELECT a.id, a.email, a.label, a.note, a.group_name, a.proxy, a.status, a.auth_state, a.last_error,
    a.last_sync_at, a.balance, a.earnings_total, a.joined_at, a.banned_at, a.paused, a.created_at,
    a.suspect_reason, a.suspect_at, a.backoff_until, a.backoff_level, a.next_sync_at, a.archived_at, a.error_streak,
    COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.status = 'paid'), 0) AS withdrawn,
    COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.status != 'paid'), 0) AS pending,
    COALESCE((SELECT last_total - first_total FROM account_daily d WHERE d.account_id = a.id AND d.date = ?), 0) AS today,
    COALESCE((SELECT SUM(bytes) FROM device_usage u WHERE u.account_id = a.id AND u.date = ?), 0) AS usage_today,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'online') AS dev_online,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'idle') AS dev_idle,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'offline') AS dev_offline,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'banned') AS dev_banned
  FROM accounts a`;
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: getSettings().timezone }).format(Date.now());

app.get('/api/accounts', (req, res) => {
  res.json(db.prepare(ACCOUNT_LIST_SQL + ' ORDER BY a.id').all(todayStr(), usageToday()));
});

app.get('/api/accounts/:id', (req, res) => {
  const acc = db.prepare(ACCOUNT_LIST_SQL + ' WHERE a.id = ?').get(todayStr(), usageToday(), req.params.id);
  if (!acc) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json({
    ...acc,
    devices: db.prepare(`SELECT d.*, COALESCE((SELECT last_total - first_total FROM device_daily dd WHERE dd.uuid = d.uuid AND dd.date = ?), 0) AS today,
        COALESCE((SELECT bytes FROM device_usage u WHERE u.uuid = d.uuid AND u.date = ?), 0) AS usage_today
      FROM devices d WHERE d.account_id = ? AND d.missing = 0 ORDER BY d.title`).all(todayStr(), usageToday(), acc.id),
    usage_daily: usageSeries(Math.min(Number(req.query.usage_days) || 7, 400), { accountId: acc.id }),
    usage_monthly: usageMonthly(6, { accountId: acc.id }),
    transactions: db.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC').all(acc.id),
    daily: dailySeries(30, { accountId: acc.id }),
    events: db.prepare('SELECT * FROM events WHERE account_id = ? ORDER BY id DESC LIMIT 30').all(acc.id),
    snapshots: db.prepare('SELECT ts, balance, earnings_total FROM balance_snapshots WHERE account_id = ? AND ts >= ? ORDER BY ts DESC')
      .all(acc.id, Date.now() - Math.min(Number(req.query.snap_days) || 7, 400) * 864e5),
    usd_vnd: getSettings().usd_vnd,
  });
});

/** Thêm 1 hoặc nhiều acc: mỗi dòng 1 cookie */
app.post('/api/accounts', async (req, res) => {
  const { cookies, label = '', note = '', group_name = '' } = req.body || {};
  let proxy;
  try { proxy = normalizeProxy(req.body?.proxy); } catch (e) { return res.status(400).json({ error: e.message }); }
  const lines = String(cookies || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Chưa nhập cookie' });
  const results = [];
  for (const line of lines) {
    try {
      const cookie = normalizeCookie(line);
      const user = await new EarnAppClient(cookie, proxy).call('user_data');
      const dup = db.prepare('SELECT id FROM accounts WHERE email = ?').get(user.email);
      if (dup) {
        db.prepare("UPDATE accounts SET cookie_enc = ?, auth_state = 'pending', archived_at = NULL, paused = 0 WHERE id = ?").run(encrypt(cookie), dup.id);
        results.push({ ok: true, email: user.email, updated: true, id: dup.id });
        continue;
      }
      const r = db.prepare('INSERT INTO accounts(email, label, note, group_name, cookie_enc, proxy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user.email, lines.length === 1 ? label : '', note, group_name, encrypt(cookie), proxy, Date.now());
      addEvent({ account_id: Number(r.lastInsertRowid), type: 'account_added', message: `Đã thêm acc ${user.email}` });
      results.push({ ok: true, email: user.email, id: Number(r.lastInsertRowid) });
    } catch (e) {
      results.push({ ok: false, error: e.message, line: line.slice(0, 20) + '…' });
    }
  }
  // Đồng bộ ngay các acc mới (chạy nền)
  const ids = results.filter(r => r.ok).map(r => r.id);
  if (ids.length) runCycle(ids).catch(() => {});
  res.json({ results });
});

app.patch('/api/accounts/:id', async (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Không tìm thấy' });
  const b = req.body || {};
  const fields = {};
  for (const k of ['label', 'note', 'group_name']) if (k in b) fields[k] = String(b[k] ?? '');
  if ('proxy' in b) {
    try { fields.proxy = normalizeProxy(b.proxy); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // Acc đã lưu trữ luôn ngừng đồng bộ; muốn chạy lại thì khôi phục
  if ('paused' in b && !acc.archived_at) fields.paused = b.paused ? 1 : 0;
  if ('archived' in b) {
    if (b.archived && !acc.archived_at) {
      fields.archived_at = Date.now();
      fields.paused = 1;
      if (acc.status !== 'banned') fields.status = 'stopped';
    } else if (!b.archived && acc.archived_at) {
      fields.archived_at = null;
      fields.paused = 0;
      fields.next_sync_at = null; // lấy dữ liệu lại ngay
    }
  }
  if (b.dismiss_suspect) { fields.suspect_reason = ''; fields.suspect_ack = 1; }
  // Running/Stopped luôn tự động theo máy. Người dùng chỉ được đánh dấu / bỏ đánh dấu bị khoá.
  if ('banned' in b) {
    if (b.banned) {
      fields.status = 'banned';
      fields.suspect_reason = '';
      if (acc.status !== 'banned') fields.banned_at = Date.now();
    } else {
      const active = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND missing = 0 AND status IN ('online', 'idle')").get(acc.id).n;
      fields.status = active > 0 ? 'running' : 'stopped';
      fields.banned_at = null;
      fields.suspect_reason = '';
      fields.suspect_ack = 1; // lần đồng bộ tới nhận số dư mới, không nghi lại
    }
  }
  if (b.cookie) {
    try {
      const cookie = normalizeCookie(b.cookie);
      await new EarnAppClient(cookie, fields.proxy ?? acc.proxy).call('user_data');
      fields.cookie_enc = encrypt(cookie);
      fields.auth_state = 'pending';
    } catch (e) {
      return res.status(400).json({ error: 'Cookie không dùng được: ' + e.message });
    }
  }
  if (Object.keys(fields).length) {
    db.prepare(`UPDATE accounts SET ${Object.keys(fields).map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: acc.id });
  }
  if ('archived_at' in fields) {
    // Máy của acc lưu trữ không hiện trong danh sách máy, không bị tính là rớt mạng. Khôi phục thì lần đồng bộ tới tự hiện lại.
    if (fields.archived_at) db.prepare("UPDATE devices SET missing = 1, online = 0, status = 'offline' WHERE account_id = ?").run(acc.id);
    addEvent({ account_id: acc.id, type: 'account_archived', level: 'info',
      message: fields.archived_at ? `${acc.label || acc.email}: đã lưu trữ, ngừng theo dõi (số liệu cũ vẫn giữ)` : `${acc.label || acc.email}: khôi phục từ lưu trữ, theo dõi lại` });
  }
  if (fields.status && fields.status !== acc.status && !('archived_at' in fields)) {
    addEvent({ account_id: acc.id, type: 'account_status', level: fields.status === 'banned' ? 'critical' : 'info',
      message: fields.status === 'banned'
        ? `${acc.label || acc.email}: được đánh dấu bị khoá, số dư ${'$' + acc.balance.toFixed(2)} tính vào "Mất do bị khoá"`
        : `${acc.label || acc.email}: bỏ đánh dấu bị khoá, trạng thái tự động trở lại` });
  }
  if (b.cookie || ('archived_at' in fields && !fields.archived_at)) runCycle([acc.id]).catch(() => {});
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/sync', async (req, res) => {
  const id = req.body?.id ? Number(req.body.id) : null;
  if (id) {
    if (db.prepare('SELECT archived_at FROM accounts WHERE id = ?').get(id)?.archived_at) return res.status(400).json({ error: 'Acc đang lưu trữ, khôi phục trước khi lấy dữ liệu' });
    await runCycle([id]);
    return res.json({ ok: true });
  }
  res.json({ ok: true, queued: requestSyncAll() });
});

// ---------- Máy, giao dịch, sự kiện ----------
app.get('/api/devices', (req, res) => {
  res.json(db.prepare(`
    SELECT d.*, COALESCE(a.label, a.email) AS account,
      COALESCE((SELECT last_total - first_total FROM device_daily dd WHERE dd.uuid = d.uuid AND dd.date = ?), 0) AS today,
      COALESCE((SELECT bytes FROM device_usage u WHERE u.uuid = d.uuid AND u.date = ?), 0) AS usage_today
    FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.missing = 0 ORDER BY a.id, d.title`).all(todayStr(), usageToday()));
});

app.get('/api/transactions', (req, res) => {
  res.json(db.prepare(`SELECT t.*, COALESCE(a.label, a.email) AS account FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.date DESC`).all());
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.prepare(`SELECT e.*, COALESCE(a.label, a.email) AS account FROM events e LEFT JOIN accounts a ON a.id = e.account_id ORDER BY e.id DESC LIMIT ?`).all(limit));
});

// ---------- Báo cáo ----------
app.get('/api/reports', (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json({
    profit: profitByMonth(6),
    devices: deviceRanking(days),
    accounts: accountRanking(days),
    daily: dailySeries(Math.max(days, 30)),
    costs: db.prepare('SELECT * FROM costs ORDER BY date DESC').all(),
    usage_monthly: usageMonthly(6),
    usd_vnd: getSettings().usd_vnd,
  });
});

app.post('/api/costs', (req, res) => {
  const { name, amount, period = 'monthly', date, end_date = null, note = '' } = req.body || {};
  if (!name || !(Number(amount) > 0) || !date) return res.status(400).json({ error: 'Thiếu tên, số tiền hoặc ngày' });
  db.prepare('INSERT INTO costs(name, amount, period, date, end_date, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, Number(amount), period === 'once' ? 'once' : 'monthly', date, end_date || null, note);
  res.json({ ok: true });
});

app.delete('/api/costs/:id', (req, res) => {
  db.prepare('DELETE FROM costs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Cài đặt ----------
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({ ...s, telegram_token: s.telegram_token ? '••••' + s.telegram_token.slice(-4) : '' });
});

app.put('/api/settings', (req, res) => {
  const b = { ...req.body };
  if (typeof b.telegram_token === 'string' && b.telegram_token.startsWith('••••')) delete b.telegram_token;
  for (const k of ['sync_min_min', 'sync_max_min', 'account_delay_sec', 'idle_hours', 'offline_grace_min', 'usd_vnd', 'daily_report_hour', 'error_alert_count']) {
    if (k in b) b[k] = Math.max(k === 'daily_report_hour' ? 0 : 1, Number(b[k]) || 0);
  }
  const cur = getSettings();
  if (Number(b.sync_max_min ?? cur.sync_max_min) < Number(b.sync_min_min ?? cur.sync_min_min)) {
    return res.status(400).json({ error: 'Thời gian tối đa phải lớn hơn hoặc bằng tối thiểu' });
  }
  setSettings(b);
  res.json({ ok: true });
});

app.post('/api/settings/telegram-test', async (req, res) => {
  try {
    const ok = await sendTelegram('✅ Kết nối Telegram thành công! Bạn sẽ nhận cảnh báo EarnApp tại đây.');
    res.json(ok ? { ok: true } : { error: 'Chưa nhập Bot token hoặc Chat ID' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Xuất CSV (mở được bằng Excel) ----------
function csv(rows, cols) {
  const escCell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map(c => c[1]).join(','), ...rows.map(r => cols.map(c => escCell(r[c[0]])).join(','))].join('\r\n');
}

app.get('/api/export/:type', (req, res) => {
  const fmtTs = ts => ts ? new Date(ts).toLocaleString('vi-VN', { timeZone: getSettings().timezone }) : '';
  let rows, cols;
  if (req.params.type === 'accounts') {
    rows = db.prepare(ACCOUNT_LIST_SQL + ' ORDER BY a.id').all(todayStr(), usageToday()).map(r => ({ ...r, last_sync_at: fmtTs(r.last_sync_at), usage_mb: (r.usage_today / 1e6).toFixed(1) }));
    cols = [['email', 'Email'], ['label', 'Tên'], ['group_name', 'Nhóm'], ['status', 'Trạng thái'], ['earnings_total', 'Lifetime ($)'], ['balance', 'Số dư ($)'],
      ['withdrawn', 'Đã rút ($)'], ['pending', 'Đang chờ rút ($)'], ['dev_online', 'Máy online'], ['dev_offline', 'Máy offline'], ['dev_banned', 'Máy bị ban'], ['usage_mb', 'Dung lượng hôm nay (MB)'], ['note', 'Ghi chú'], ['last_sync_at', 'Cập nhật lúc']];
  } else if (req.params.type === 'transactions') {
    rows = db.prepare('SELECT t.*, a.email FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.date DESC').all();
    cols = [['email', 'Email'], ['date', 'Ngày tạo'], ['amount', 'Số tiền ($)'], ['fee', 'Phí ($)'], ['payment_method', 'Phương thức'], ['status', 'Trạng thái'], ['payment_date', 'Ngày thanh toán']];
  } else if (req.params.type === 'devices') {
    rows = db.prepare('SELECT d.*, a.email FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.missing = 0').all();
    cols = [['email', 'Email'], ['title', 'Tên máy'], ['uuid', 'UUID'], ['status', 'Trạng thái'], ['country', 'Quốc gia'], ['earned_total', 'Tổng kiếm ($)'], ['banned_reason', 'Lý do ban']];
  } else if (req.params.type === 'report') {
    const r = report(req.query);
    rows = r.accounts.map(a => ({ ...a, usage_gb: (a.usage / 1e9).toFixed(3), uptime_pct: a.uptime == null ? '' : (a.uptime * 100).toFixed(1), share_pct: (a.share * 100).toFixed(1) }));
    cols = [['name', 'Tài khoản'], ['email', 'Email'], ['group', 'Nhóm'], ['status', 'Trạng thái'], ['earned', `Thu nhập ${r.from} → ${r.to} ($)`],
      ['prev_earned', 'Kỳ trước ($)'], ['share_pct', 'Tỷ trọng (%)'], ['usage_gb', 'Dung lượng (GB)'], ['per_gb', '$/GB'], ['devices', 'Máy hoạt động'],
      ['per_device_day', '$/máy/ngày'], ['uptime_pct', 'Uptime (%)'], ['payouts', 'Đã rút trong kỳ ($)'], ['balance', 'Số dư ($)'], ['lifetime', 'Lifetime ($)']];
  } else if (req.params.type === 'usage') {
    rows = db.prepare(`SELECT u.date, a.email, COALESCE(d.title, u.uuid) AS title, u.bytes FROM device_usage u
      JOIN accounts a ON a.id = u.account_id LEFT JOIN devices d ON d.uuid = u.uuid ORDER BY u.date DESC, a.email, title`).all()
      .map(r => ({ ...r, mb: (r.bytes / 1e6).toFixed(2) }));
    cols = [['date', 'Ngày'], ['email', 'Email'], ['title', 'Máy'], ['mb', 'Dung lượng (MB)'], ['bytes', 'Byte']];
  } else if (req.params.type === 'snapshots') {
    rows = db.prepare('SELECT s.*, a.email FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id ORDER BY s.account_id, s.ts').all().map(r => ({ ...r, ts: fmtTs(r.ts) }));
    cols = [['email', 'Email'], ['ts', 'Thời điểm'], ['balance', 'Số dư ($)'], ['earnings_total', 'Lifetime ($)']];
  } else return res.status(404).end();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="earnapp-${req.params.type}-${todayStr()}.csv"`);
  res.send(csv(rows, cols));
});

// ---------- Sao lưu: file zip gồm database + khoá giải mã cookie ----------
app.get('/api/backup', (req, res) => {
  const tmp = path.join(os.tmpdir(), `eam-backup-${Date.now()}.db`);
  try {
    // VACUUM INTO tạo bản sao nhất quán kể cả khi web đang ghi dữ liệu
    db.prepare('VACUUM INTO ?').run(tmp);
    const files = [{ name: 'earnapp.db', data: fs.readFileSync(tmp) }];
    const keyFile = path.join(DATA_DIR, 'secret.key');
    if (!process.env.SECRET_KEY && fs.existsSync(keyFile)) files.push({ name: 'secret.key', data: fs.readFileSync(keyFile) });
    files.push({ name: 'HUONG-DAN-KHOI-PHUC.txt', data: Buffer.from([
      'KHÔI PHỤC DỮ LIỆU EARNAPP MANAGER',
      '',
      '1. Tắt web (docker compose down, hoặc Ctrl+C nếu chạy npm start).',
      '2. Trong thư mục data/: xoá earnapp.db-wal và earnapp.db-shm nếu có.',
      '3. Chép earnapp.db' + (files.length > 1 ? ' và secret.key' : '') + ' từ file zip này vào thư mục data/ (ghi đè).',
      process.env.SECRET_KEY ? '   Web đang dùng SECRET_KEY trong .env: phải giữ đúng SECRET_KEY cũ, nếu không cookie các acc sẽ không đọc được.' : null,
      '4. Bật lại web.',
      '',
      'LƯU Ý: file này chứa cookie EarnApp' + (files.length > 1 ? ' và khoá để giải mã' : '') + '. Ai có file là truy cập được các acc, cần giữ kín.',
    ].filter(l => l !== null).join('\r\n'), 'utf8') });
    const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: getSettings().timezone, dateStyle: 'short', timeStyle: 'short' }).format(Date.now()).replace(/[: ]/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="earnapp-backup-${stamp}.zip"`);
    res.send(zip(files));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Lỗi máy chủ' });
});

// ---------- Giao diện ----------
const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(config.port, () => {
  console.log(`EarnApp Manager chạy tại http://localhost:${config.port}`);
  startScheduler();
});
