import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, getSettings, setSettings, addEvent } from './db.js';
import { encrypt, verifyPassword, hashPassword, signSession, verifySession } from './crypto.js';
import { normalizeCookie, normalizeProxy, EarnAppClient } from './earnapp.js';
import { runCycle, startScheduler, syncState, requestSyncAll, getProgress, PARALLEL_LIMIT } from './sync.js';
import { staleMs, summary, dailySeries, profitByMonth, deviceRanking, accountRanking, usageSeries, usageToday, usageMonthly } from './stats.js';
import { sendTelegramEach, chatIds, validChatId } from './telegram.js';
import { byAccount, cmp, fullName, proxyInfo } from './accname.js';
import { methodName } from './alerts.js';
import { overview, report, scopeOptions } from './reports.js';
import { startAddJob, listJobs, dismissJob, retryJob, resumeJobs } from './addJobs.js';
import { BackupError, makeBackup, checkRestore, applyRestore, cancelRestore, exportAccounts, importAccounts } from './backup.js';
import { MachineError, resolveMachine, listMachines, createMachine, updateMachine, deleteMachine, moveAccounts } from './machines.js';
import { PAYOUT_METHODS, methodLabel, validateSchedule, describeSchedule, saveSchedule, runWithdraw, validateTarget, notifyChange, applyTimezone, startWithdrawScheduler, withdrawProgress } from './withdraw.js';

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
  res.json({ ok: true, username: user.username, timezone: getSettings().timezone });
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

app.get('/api/me', (req, res) => res.json({ username: req.user, timezone: getSettings().timezone }));

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
    events: db.prepare(`SELECT e.*, COALESCE(NULLIF(a.label, '') || ' · ' || a.email, a.email) AS account FROM events e LEFT JOIN accounts a ON a.id = e.account_id ORDER BY e.id DESC LIMIT 15`).all(),
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
    a.suspect_reason, a.suspect_at, a.backoff_until, a.backoff_level, a.next_sync_at, a.archived_at, a.error_streak, a.last_ok_at,
    COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.status = 'paid'), 0) AS withdrawn,
    COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.status != 'paid'), 0) AS pending,
    COALESCE((SELECT last_total - first_total FROM account_daily d WHERE d.account_id = a.id AND d.date = ?), 0) AS today,
    COALESCE((SELECT SUM(bytes) FROM device_usage u WHERE u.account_id = a.id AND u.date = ?), 0) AS usage_today,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'online') AS dev_online,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'idle') AS dev_idle,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'offline') AS dev_offline,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'banned') AS dev_banned,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'unknown') AS dev_unknown
  FROM accounts a`;
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: getSettings().timezone }).format(Date.now());

// stale: quá lâu không lấy được dữ liệu mới, số liệu đang hiện là của lần thành công cuối (last_ok_at)
const withStale = a => a && ({ ...a, stale: !a.archived_at && !a.paused && (a.last_ok_at || 0) < Date.now() - staleMs() });

app.get('/api/accounts', (req, res) => {
  res.json(db.prepare(ACCOUNT_LIST_SQL).all(todayStr(), usageToday()).sort(byAccount).map(a => ({ ...withStale(a), proxy_info: proxyInfo(a.proxy) })));
});

// Tiến độ lấy dữ liệu (vừa thêm acc / bấm đồng bộ): ?ids=1,2,3
app.get('/api/accounts/progress', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
  res.json(getProgress(ids));
});

app.get('/api/accounts/:id', (req, res) => {
  const acc = withStale(db.prepare(ACCOUNT_LIST_SQL + ' WHERE a.id = ?').get(todayStr(), usageToday(), req.params.id));
  if (acc) acc.proxy_info = proxyInfo(acc.proxy);
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

// ---------- Máy ----------
const machineRoute = fn => (req, res) => {
  try { res.json(fn(req)); } catch (e) {
    if (e instanceof MachineError) return res.status(400).json({ error: e.message });
    throw e;
  }
};
app.get('/api/machines', (req, res) => res.json(listMachines()));
app.post('/api/machines', machineRoute(req => createMachine(req.body || {})));
app.patch('/api/machines/:id', machineRoute(req => updateMachine(Number(req.params.id), req.body || {})));
app.delete('/api/machines/:id', machineRoute(req => { deleteMachine(Number(req.params.id)); return { ok: true }; }));
// Chuyển nhiều acc sang 1 máy: { ids: [...], machine: 'Máy A' | '' }
app.post('/api/machines/move', machineRoute(req => ({ moved: moveAccounts(req.body?.ids, req.body?.machine) })));

/**
 * Thêm 1 hoặc nhiều acc: rows [{ cookie, label, proxy }] (hoặc cookies: mỗi dòng 1 cookie).
 * Trả về ngay; kiểm tra cookie + tải dữ liệu chạy ngầm, xong thì báo (xem addJobs.js)
 */
app.post('/api/accounts', (req, res) => {
  const b = req.body || {};
  try {
    res.json({ job: startAddJob(Array.isArray(b.rows) ? b.rows : b.cookies, { label: b.label, note: b.note, group_name: b.group_name, proxy: b.proxy }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Các lượt thêm acc chạy ngầm chưa đóng thông báo
app.get('/api/add-jobs', (req, res) => res.json(listJobs()));
app.post('/api/add-jobs/:id/dismiss', (req, res) => { dismissJob(Number(req.params.id)); res.json({ ok: true }); });
app.post('/api/add-jobs/:id/retry', (req, res) => {
  try { res.json({ job: retryJob(Number(req.params.id), req.body?.proxies || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/accounts/:id', async (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Không tìm thấy' });
  const b = req.body || {};
  const fields = {};
  if ('note' in b) fields.note = String(b.note ?? '');
  if ('group_name' in b) {
    try { fields.group_name = resolveMachine(b.group_name); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if ('label' in b) fields.label = String(b.label ?? '').trim().slice(0, 40) || null;
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
  // Running/Stopped luôn tự động theo node. Người dùng chỉ được đánh dấu / bỏ đánh dấu bị khoá.
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
    // Node của acc lưu trữ không hiện trong danh sách node, không bị tính là rớt mạng. Khôi phục thì lần đồng bộ tới tự hiện lại.
    if (fields.archived_at) db.prepare("UPDATE devices SET missing = 1, online = 0, status = 'offline' WHERE account_id = ?").run(acc.id);
    addEvent({ account_id: acc.id, type: 'account_archived', level: 'info',
      message: fields.archived_at ? `${fullName(acc)}: đã lưu trữ, ngừng theo dõi (số liệu cũ vẫn giữ)` : `${fullName(acc)}: khôi phục từ lưu trữ, theo dõi lại` });
  }
  if (fields.status && fields.status !== acc.status && !('archived_at' in fields)) {
    addEvent({ account_id: acc.id, type: 'account_status', level: fields.status === 'banned' ? 'critical' : 'info',
      message: fields.status === 'banned'
        ? `${fullName(acc)}: được đánh dấu bị khoá, số dư ${'$' + acc.balance.toFixed(2)} tính vào "Mất do bị khoá"`
        : `${fullName(acc)}: bỏ đánh dấu bị khoá, trạng thái tự động trở lại` });
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

// ---------- Hẹn giờ rút tiền ----------
// Thao tác có thể làm tiền đi ra ngoài (lưu lịch, bật lịch, rút ngay) phải nhập lại mật khẩu web.
// Mã 403 (không phải 401) để giao diện không tự đăng xuất khi gõ sai.
const pwAttempts = new Map();
function checkPassword(req, res) {
  const key = req.ip;
  const a = pwAttempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) { res.status(429).json({ error: 'Sai mật khẩu quá nhiều lần, thử lại sau 5 phút' }); return false; }
  const user = db.prepare('SELECT pw_hash FROM users WHERE username = ?').get(req.user);
  if (!verifyPassword(String(req.body?.password || ''), user.pw_hash)) {
    a.n++;
    if (a.n >= 5) { a.until = Date.now() + 5 * 60e3; a.n = 0; }
    pwAttempts.set(key, a);
    res.status(403).json({ error: 'Mật khẩu không đúng' });
    return false;
  }
  pwAttempts.delete(key);
  return true;
}

app.get('/api/withdraw', (req, res) => {
  res.json({
    methods: PAYOUT_METHODS,
    payout_emails: config.payoutEmails,
    timezone: getSettings().timezone,
    progress: withdrawProgress(), // { [account_id]: { state: queued | running, step, since, manual } }
    now: Date.now(),
    accounts: db.prepare(`SELECT a.id, a.email, a.label, a.group_name, a.balance, a.status, a.auth_state, a.archived_at, a.redeem_details,
        w.mode, w.run_date, w.weekdays, w.time, w.method, w.email AS pay_email, w.enabled, w.next_run_at, w.last_run_at, w.last_status, w.last_message
      FROM accounts a LEFT JOIN withdraw_schedules w ON w.account_id = a.id ORDER BY a.archived_at IS NOT NULL, a.id`).all(),
    log: db.prepare(`SELECT l.*, COALESCE(NULLIF(a.label, '') || ' · ' || a.email, a.email) AS account, a.label, a.email AS acc_email FROM withdraw_log l JOIN accounts a ON a.id = l.account_id ORDER BY l.id DESC LIMIT 100`).all(),
  });
});

/** Lưu lịch cho 1 hoặc nhiều acc (ids) cùng lúc */
app.put('/api/withdraw', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(id => db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id));
  if (!ids.length) return res.status(400).json({ error: 'Chưa chọn acc' });
  // Kiểm tra hết các acc trước (mỗi acc có email đăng ký riêng), sai 1 acc thì không lưu acc nào
  try {
    for (const id of ids) {
      const acc = db.prepare('SELECT id, label, email FROM accounts WHERE id = ?').get(id);
      try { validateSchedule(req.body, Date.now(), getSettings().timezone, acc.email); } catch (e) { throw new Error(`${acc.label || acc.email || '#' + id}: ${e.message}`); }
    }
  } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!checkPassword(req, res)) return;
  for (const id of ids) {
    const sch = saveSchedule(id, req.body);
    notifyChange([id], `lưu lịch rút ${describeSchedule(sch)} qua ${methodLabel(sch.method)} tới ${sch.email}`, req.ip);
  }
  res.json({ ok: true });
});

app.patch('/api/withdraw/:id', (req, res) => {
  const enabled = req.body?.enabled ? 1 : 0;
  const sch = db.prepare('SELECT * FROM withdraw_schedules WHERE account_id = ?').get(req.params.id);
  if (!sch) return res.status(404).json({ error: 'Không tìm thấy' });
  if (enabled) {
    const own = db.prepare('SELECT email FROM accounts WHERE id = ?').get(sch.account_id)?.email;
    try { validateSchedule({ ...sch, enabled }, Date.now(), getSettings().timezone, own); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!checkPassword(req, res)) return;
    saveSchedule(sch.account_id, { ...sch, enabled });
  } else {
    // Tắt lịch không làm mất tiền: không cần mật khẩu, và luôn tắt được kể cả khi email đã bị gỡ khỏi danh sách
    db.prepare('UPDATE withdraw_schedules SET enabled = 0, next_run_at = NULL, attempts = 0 WHERE account_id = ?').run(sch.account_id);
  }
  notifyChange([sch.account_id], enabled ? `bật lại lịch rút tới ${sch.email}` : 'tắt lịch rút', req.ip);
  res.json({ ok: true });
});

app.delete('/api/withdraw/:id', (req, res) => {
  const r = db.prepare('DELETE FROM withdraw_schedules WHERE account_id = ?').run(req.params.id);
  if (r.changes) notifyChange([Number(req.params.id)], 'xoá lịch rút', req.ip);
  res.json({ ok: true });
});

app.post('/api/withdraw/:id/run', async (req, res) => {
  const id = Number(req.params.id);
  const acc = db.prepare('SELECT id, email FROM accounts WHERE id = ?').get(id);
  if (!acc) return res.status(404).json({ error: 'Không tìm thấy acc' });
  // Có gửi method/email: rút ngay tới đó, không cần lịch. Không gửi: dùng phương thức + email trong lịch đã lưu
  let target = null;
  if (req.body?.method || req.body?.email) {
    try { target = validateTarget(req.body, acc.email); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if (!checkPassword(req, res)) return;
  // Không báo riêng lúc bấm: tin kết quả (luôn gửi) đã ghi IP người bấm, tránh 1 lần rút ra nhiều tin
  const r = await runWithdraw(id, { manual: true, target, ip: req.ip });
  res.status(r.status === 'ok' ? 200 : 400).json(r.status === 'ok' ? r : { ...r, error: r.message });
});

app.get('/api/devices', (req, res) => {
  res.json(db.prepare(`
    SELECT d.*, COALESCE(NULLIF(a.label, '') || ' · ' || a.email, a.email) AS account, a.label, a.email, a.group_name, a.last_ok_at,
      COALESCE((SELECT last_total - first_total FROM device_daily dd WHERE dd.uuid = d.uuid AND dd.date = ?), 0) AS today,
      COALESCE((SELECT bytes FROM device_usage u WHERE u.uuid = d.uuid AND u.date = ?), 0) AS usage_today
    FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.missing = 0 ORDER BY a.id, d.title`).all(todayStr(), usageToday()));
});

app.get('/api/transactions', (req, res) => {
  res.json(db.prepare(`SELECT t.*, COALESCE(NULLIF(a.label, '') || ' · ' || a.email, a.email) AS account, a.label, a.email, a.group_name FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.date DESC`).all());
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.prepare(`SELECT e.*, COALESCE(NULLIF(a.label, '') || ' · ' || a.email, a.email) AS account FROM events e LEFT JOIN accounts a ON a.id = e.account_id ORDER BY e.id DESC LIMIT ?`).all(limit));
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
  delete b.timezone; // múi giờ đặt trong code (EARNAPP_TZ)
  if (typeof b.telegram_token === 'string' && b.telegram_token.startsWith('••••')) delete b.telegram_token;
  if ('max_parallel' in b) b.max_parallel = Math.min(PARALLEL_LIMIT, Math.max(1, Math.round(Number(b.max_parallel) || 1)));
  for (const k of ['sync_min_min', 'sync_max_min', 'account_delay_sec', 'idle_hours', 'offline_grace_min', 'usd_vnd', 'daily_report_hour', 'error_alert_count']) {
    if (k in b) b[k] = Math.max(k === 'daily_report_hour' ? 0 : 1, Number(b[k]) || 0);
  }
  if (typeof b.telegram_chat_id === 'string') {
    const ids = chatIds(b.telegram_chat_id);
    const bad = ids.filter(id => !validChatId(id));
    if (bad.length) return res.status(400).json({ error: `Chat ID không hợp lệ: ${bad.join(', ')}. Chat riêng là số dương, nhóm là số âm (VD -1001234567890), kênh là @tenkenh` });
    b.telegram_chat_id = ids.join(', ');
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
    const r = await sendTelegramEach('✅ Kết nối Telegram thành công! Bạn sẽ nhận cảnh báo EarnApp tại đây.');
    if (!r.length) return res.json({ error: 'Chưa nhập Bot token hoặc Chat ID' });
    const failed = r.filter(x => !x.ok);
    if (!failed.length) return res.json({ ok: true, sent: r.length });
    const okPart = r.length > failed.length ? `Đã gửi tới ${r.length - failed.length}/${r.length} nơi. ` : '';
    res.status(400).json({ error: okPart + failed.map(f => `Lỗi ${f.chat}: ${f.error.replace(/^Telegram: /, '')}`).join('; ') });
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

// Trạng thái bằng tiếng Việt trong file Excel
const ACC_STATUS_VI = { running: 'Đang chạy', stopped: 'Đã dừng', banned: 'Bị khoá' };
const DEV_STATUS_VI = { online: 'Đang chạy', idle: 'Lâu không tăng tiền', offline: 'Rớt mạng', banned: 'Bị ban', unknown: 'Chưa rõ' };
const TX_STATUS_VI = { paid: 'Đã nhận', pending_procedure: 'Đang xử lý', approved: 'Đã duyệt', pending: 'Đang chờ' };
const BAN_REASON_VI = { earnapp_blacklist: 'IP trong danh sách đen', ip_quality: 'IP chất lượng kém' };
// Mọi file đều mở đầu bằng Máy / Tên / Email và xếp acc cùng một thứ tự như trên web
const ACC_COLS = [['group_name', 'Máy'], ['label', 'Tên'], ['email', 'Email']];
const ACC_JOIN = 'a.group_name, a.label, a.email';

app.get('/api/export/:type', (req, res) => {
  const tz = getSettings().timezone;
  const fmtTs = ts => ts ? new Date(ts).toLocaleString('vi-VN', { timeZone: tz }) : '';
  const fmtDay = d => d ? new Date(d).toLocaleDateString('vi-VN', { timeZone: tz }) : '';
  const usd2 = n => n == null ? '' : Number(n).toFixed(2);
  let rows, cols;
  if (req.params.type === 'accounts') {
    rows = db.prepare(ACCOUNT_LIST_SQL).all(todayStr(), usageToday()).sort(byAccount).map(r => ({
      ...r, status_vi: r.archived_at ? 'Lưu trữ' : withStale(r).stale && r.status !== 'banned' ? 'Chưa rõ' : ACC_STATUS_VI[r.status] || r.status, proxy_vi: proxyInfo(r.proxy),
      today: Number(r.today).toFixed(3), earnings_total: usd2(r.earnings_total), balance: usd2(r.balance), withdrawn: usd2(r.withdrawn), pending: usd2(r.pending),
      last_ok_at: fmtTs(r.last_ok_at), usage_mb: (r.usage_today / 1e6).toFixed(1),
    }));
    cols = [...ACC_COLS, ['status_vi', 'Trạng thái'], ['dev_online', 'Node chạy'], ['dev_idle', 'Node lâu không tăng tiền'], ['dev_offline', 'Node rớt mạng'], ['dev_banned', 'Node bị ban'],
      ['today', 'Hôm nay ($)'], ['usage_mb', 'Dung lượng hôm nay (MB)'], ['balance', 'Số dư ($)'], ['withdrawn', 'Đã rút ($)'], ['pending', 'Đang chờ rút ($)'],
      ['earnings_total', 'Tổng kiếm ($)'], ['proxy_vi', 'Proxy'], ['note', 'Ghi chú'], ['last_ok_at', 'Cập nhật lúc']];
  } else if (req.params.type === 'transactions') {
    rows = db.prepare(`SELECT t.*, ${ACC_JOIN} FROM transactions t JOIN accounts a ON a.id = t.account_id`).all()
      .sort((x, y) => byAccount(x, y) || String(y.date).localeCompare(String(x.date)))
      .map(r => ({ ...r, date: fmtDay(r.date), payment_date: fmtDay(r.payment_date), method: methodName(r.payment_method), status_vi: TX_STATUS_VI[r.status] || r.status, amount: usd2(r.amount), fee: usd2(r.fee) }));
    cols = [...ACC_COLS, ['date', 'Ngày tạo lệnh'], ['amount', 'Số tiền ($)'], ['fee', 'Phí ($)'], ['method', 'Phương thức'], ['status_vi', 'Trạng thái'], ['payment_date', 'Ngày nhận tiền']];
  } else if (req.params.type === 'devices') {
    rows = db.prepare(`SELECT d.*, ${ACC_JOIN},
        COALESCE((SELECT last_total - first_total FROM device_daily dd WHERE dd.uuid = d.uuid AND dd.date = ?), 0) AS today,
        COALESCE((SELECT bytes FROM device_usage u WHERE u.uuid = d.uuid AND u.date = ?), 0) AS usage_today
      FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.missing = 0`).all(todayStr(), usageToday())
      .sort((x, y) => byAccount(x, y) || cmp(x.title, y.title))
      .map(r => ({ ...r, status_vi: DEV_STATUS_VI[r.status] || r.status, country: (r.country || '').toUpperCase(), ban_vi: r.banned_reason ? BAN_REASON_VI[r.banned_reason] || r.banned_reason : '',
        today: Number(r.today).toFixed(3), usage_mb: (r.usage_today / 1e6).toFixed(1), earned_total: Number(r.earned_total || 0).toFixed(3), last_online: fmtTs(r.last_online_at) }));
    cols = [...ACC_COLS, ['title', 'Node'], ['status_vi', 'Trạng thái'], ['country', 'Quốc gia'], ['today', 'Hôm nay ($)'], ['usage_mb', 'Dung lượng hôm nay (MB)'],
      ['earned_total', 'Tổng kiếm ($)'], ['ban_vi', 'Lý do ban'], ['last_online', 'Online lần cuối'], ['uuid', 'Mã node']];
  } else if (req.params.type === 'report') {
    const r = report(req.query);
    rows = r.accounts.map(a => ({ ...a, group_name: a.group, status_vi: ACC_STATUS_VI[a.status] || a.status, usage_gb: (a.usage / 1e9).toFixed(3), balance: usd2(a.balance), lifetime: usd2(a.lifetime), payouts: usd2(a.payouts),
      uptime_pct: a.uptime == null ? '' : (a.uptime * 100).toFixed(1), share_pct: (a.share * 100).toFixed(1) })).sort(byAccount);
    cols = [...ACC_COLS, ['status_vi', 'Trạng thái'], ['earned', `Thu nhập ${r.from.split('-').reverse().join('/')} → ${r.to.split('-').reverse().join('/')} ($)`],
      ['prev_earned', 'Kỳ trước ($)'], ['share_pct', 'Tỷ trọng (%)'], ['usage_gb', 'Dung lượng (GB)'], ['per_gb', '$/GB'], ['devices', 'Node hoạt động'],
      ['per_device_day', '$/node/ngày'], ['uptime_pct', 'Online (%)'], ['payouts', 'Tiền về trong kỳ ($)'], ['balance', 'Số dư ($)'], ['lifetime', 'Tổng kiếm ($)']];
  } else if (req.params.type === 'usage') {
    rows = db.prepare(`SELECT u.date, ${ACC_JOIN}, COALESCE(d.title, u.uuid) AS title, u.bytes FROM device_usage u
      JOIN accounts a ON a.id = u.account_id LEFT JOIN devices d ON d.uuid = u.uuid`).all()
      .sort((x, y) => String(y.date).localeCompare(String(x.date)) || byAccount(x, y) || cmp(x.title, y.title))
      .map(r => ({ ...r, day: r.date.split('-').reverse().join('/'), mb: (r.bytes / 1e6).toFixed(2) }));
    cols = [['day', 'Ngày'], ...ACC_COLS, ['title', 'Node'], ['mb', 'Dung lượng (MB)']];
  } else if (req.params.type === 'snapshots') {
    rows = db.prepare(`SELECT s.*, ${ACC_JOIN} FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id`).all()
      .sort((x, y) => byAccount(x, y) || x.ts - y.ts)
      .map(r => ({ ...r, ts: fmtTs(r.ts), balance: Number(r.balance).toFixed(3), earnings_total: Number(r.earnings_total).toFixed(3) }));
    cols = [...ACC_COLS, ['ts', 'Thời điểm'], ['balance', 'Số dư ($)'], ['earnings_total', 'Tổng kiếm ($)']];
  } else return res.status(404).end();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="earnapp-${req.params.type}-${todayStr()}.csv"`);
  res.send(csv(rows, cols));
});

// ---------- Sao lưu: file zip gồm database + khoá giải mã cookie ----------
// ---------- Sao lưu / khôi phục, xuất / nhập danh sách acc (xem backup.js) ----------
const sendFile = (res, f, type) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(f.data);
};
const backupRoute = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof BackupError) return res.status(400).json({ error: e.message });
    throw e;
  }
};
const upload = express.raw({ type: () => true, limit: '1gb' });

app.get('/api/backup', (req, res) => sendFile(res, makeBackup(), 'application/zip'));
// Khôi phục 2 bước: tải file lên để kiểm tra + xem tóm tắt, rồi mới đồng ý
app.post('/api/restore/check', upload, backupRoute((req, res) => res.json(checkRestore(req.body))));
app.delete('/api/restore', (req, res) => { cancelRestore(); res.json({ ok: true }); });
app.post('/api/restore/apply', backupRoute((req, res) => {
  applyRestore();
  res.json({ ok: true });
  // Tắt web để đổi dữ liệu lúc khởi động (systemd tự bật lại sau vài giây)
  console.log('Khôi phục từ file sao lưu: khởi động lại web');
  setTimeout(() => process.exit(0), 500);
}));
app.post('/api/accounts-file/export', backupRoute((req, res) => sendFile(res, exportAccounts(req.body?.password), 'application/json')));
// Mật khẩu file gửi ở header (không nằm trong đường dẫn, không vào log)
app.post('/api/accounts-file/import', upload, backupRoute((req, res) => {
  res.json(importAccounts(req.body, decodeURIComponent(req.get('x-file-password') || '')));
}));

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

app.listen(config.port, err => {
  // Cổng đã có web khác chạy: thoát hẳn. Nếu vẫn chạy lịch đồng bộ thì 2 web cùng gọi EarnApp và gửi trùng tin Telegram
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Cổng ${config.port} đang có web khác chạy. Tắt web cũ trước rồi chạy lại.` : err);
    process.exit(1);
  }
  console.log(`EarnApp Manager chạy tại http://localhost:${config.port}`);
  applyTimezone();
  startScheduler();
  resumeJobs();
  startWithdrawScheduler();
});
