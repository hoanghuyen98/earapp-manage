import { db, getSettings, setSettings, addEvent, tx } from './db.js';
import { decrypt } from './crypto.js';
import { EarnAppClient, AuthError, BannedError, RateLimitError } from './earnapp.js';
import { sendTelegram, esc } from './telegram.js';
import { formatAlerts } from './alerts.js';
import { localDate, summary, addDays, fmtBytes } from './stats.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = n => '$' + (n || 0).toFixed(2);
const accName = a => a.label || a.email || `Acc #${a.id}`;

export const syncState = { running: false, current: null, lastCycleAt: null, nextCycleAt: null };

/** Ghi số liệu theo ngày: first_total lấy từ last_total của ngày trước để không mất phần kiếm được qua đêm */
function upsertDaily(table, keyCol, key, date, total) {
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND date = ?`).get(key, date);
  if (row) {
    // Tổng bị giảm (acc bị reset...) thì hạ first_total theo, tránh thu nhập âm
    db.prepare(`UPDATE ${table} SET last_total = ?, first_total = MIN(first_total, ?) WHERE ${keyCol} = ? AND date = ?`).run(total, total, key, date);
  } else {
    const prev = db.prepare(`SELECT last_total FROM ${table} WHERE ${keyCol} = ? AND date < ? ORDER BY date DESC LIMIT 1`).get(key, date);
    const first = prev && prev.last_total <= total ? prev.last_total : total;
    db.prepare(`INSERT INTO ${table}(${keyCol}, date, first_total, last_total) VALUES (?, ?, ?, ?)`).run(key, date, first, total);
  }
}

function deviceStatus(dev, s, now) {
  if (dev.banned_reason) return 'banned';
  if (!dev.online) return 'offline';
  // Online nhưng không tăng tiền quá idle_hours -> idle (vàng)
  const ref = Math.max(dev.last_earn_at || 0, dev.online_since || now, dev.first_seen_at || now);
  return now - ref > s.idle_hours * 3600e3 ? 'idle' : 'online';
}

/** Đồng bộ 1 tài khoản. Trả về danh sách dòng cảnh báo cho Telegram. */
export async function syncAccount(acc, s = getSettings()) {
  const alerts = [];
  const now = Date.now();
  const firstSync = !acc.last_sync_at;
  // Mỗi cảnh báo mang đủ thông tin acc để soạn tin rõ ràng (gom theo acc khi gửi)
  const A = (type, extra = {}) => ({ type, ts: now, account_id: acc.id, label: acc.label, email: acc.email, ...extra });
  const client = new EarnAppClient(decrypt(acc.cookie_enc), acc.proxy);

  let data;
  try {
    // Số liệu tháng ít thay đổi: chỉ lấy mỗi giờ 1 lần để đỡ gọi EarnApp
    data = await client.fetchAll({ withMonthly: !acc.usage_monthly_at || now - acc.usage_monthly_at > 3600e3 });
  } catch (e) {
    if (e instanceof AuthError) {
      db.prepare("UPDATE accounts SET auth_state = 'expired', last_error = ?, last_sync_at = ? WHERE id = ?").run('Cookie hết hạn hoặc đã đăng xuất', now, acc.id);
      if (acc.auth_state !== 'expired') {
        addEvent({ account_id: acc.id, type: 'auth', level: 'warning', message: `${accName(acc)}: cookie hết hạn, cần cập nhật cookie mới` });
        if (s.notify_auth) alerts.push(A('auth'));
      }
    } else if (e instanceof BannedError) {
      db.prepare("UPDATE accounts SET status = 'banned', auth_state = 'ok', banned_at = COALESCE(banned_at, ?), last_error = ?, last_sync_at = ? WHERE id = ?").run(now, e.message, now, acc.id);
      if (acc.status !== 'banned') {
        addEvent({ account_id: acc.id, type: 'account_banned', level: 'critical', message: `${accName(acc)} bị khoá (${e.message}). Số dư kẹt: ${money(acc.balance)}` });
        if (s.notify_account_banned) alerts.push(A('account_banned', { amount: acc.balance }));
      }
    } else if (e instanceof RateLimitError) {
      // Giãn thời gian chờ: 5 → 10 → 20 → 40 → ... tối đa 120 phút
      const level = acc.backoff_level + 1;
      const waitMs = Math.max(e.retryAfter * 1000, Math.min(5 * 2 ** (level - 1), 120) * 60e3);
      const until = now + waitMs;
      db.prepare('UPDATE accounts SET backoff_level = ?, backoff_until = ?, last_error = ?, last_sync_at = ? WHERE id = ?')
        .run(level, until, `${e.message}. Tạm ngừng gọi ${Math.round(waitMs / 60e3)} phút`, now, acc.id);
      if (level === 3) {
        addEvent({ account_id: acc.id, type: 'rate_limit', level: 'warning', message: `${accName(acc)}: EarnApp giới hạn truy cập liên tục, web đang giãn thời gian chờ` });
        if (s.notify_rate_limit) alerts.push(A('rate_limit'));
      }
      alerts.rateLimited = true;
    } else {
      // Lỗi khác (proxy chết, mạng, EarnApp lỗi…): đếm số lần liên tiếp, đủ ngưỡng thì báo 1 lần
      const streak = (acc.error_streak || 0) + 1;
      const msg = String(e.message).slice(0, 300);
      db.prepare("UPDATE accounts SET auth_state = 'error', last_error = ?, last_sync_at = ?, error_streak = ? WHERE id = ?").run(msg, now, streak, acc.id);
      if (streak === Math.max(1, Number(s.error_alert_count) || 3)) {
        addEvent({ account_id: acc.id, type: 'sync_error', level: 'critical', message: `${accName(acc)}: lấy dữ liệu lỗi ${streak} lần liên tiếp (${msg})` });
        if (s.notify_sync_error) alerts.push(A('sync_error', { why: msg, count: streak, proxy: !!acc.proxy }));
      }
    }
    return alerts;
  }

  const { user, money: m, devices, transactions, usage, usageMonthly } = data;
  let { statuses } = data;

  // Trạng thái máy rỗng trong khi lần trước còn máy online: có thể EarnApp lỗi thoáng qua.
  // Lần đầu gặp thì giữ trạng thái cũ, chỉ tin "tất cả rớt" khi 2 lần liên tiếp đều rỗng.
  let emptyStreak = 0;
  if (devices.length && !Object.keys(statuses).length) {
    emptyStreak = (acc.empty_status_streak || 0) + 1;
    const prevOnline = db.prepare("SELECT uuid, online_since FROM devices WHERE account_id = ? AND missing = 0 AND online = 1").all(acc.id);
    if (prevOnline.length && emptyStreak < 2) {
      statuses = Object.fromEntries(prevOnline.map(d => [d.uuid, [d.online_since, 0]]));
      console.warn(`${accName(acc)}: EarnApp trả trạng thái máy rỗng, tạm giữ trạng thái cũ`);
    }
  }
  db.prepare('UPDATE accounts SET empty_status_streak = ? WHERE id = ?').run(emptyStreak, acc.id);
  const today = localDate(now, s.timezone);

  const balance = m.balance || 0, total = m.earnings_total || 0;

  // --- Nghi bị khoá: EarnApp vẫn trả dữ liệu nhưng bất thường ---
  const reasons = [];
  if (!firstSync && !acc.suspect_ack && acc.status !== 'banned') {
    const prevDevices = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND missing = 0').get(acc.id).n;
    const knownTx = new Set(db.prepare('SELECT uuid FROM transactions WHERE account_id = ?').all(acc.id).map(r => r.uuid));
    const newPayout = (transactions || []).some(t => !knownTx.has(t.uuid));
    if (prevDevices > 0 && devices.length === 0) reasons.push(`tất cả ${prevDevices} máy biến mất`);
    if (total < acc.earnings_total - 0.01) reasons.push(`tổng kiếm giảm từ ${money(acc.earnings_total)} xuống ${money(total)}`);
    else if (balance < acc.balance - 0.01 && !newPayout) reasons.push(`số dư giảm từ ${money(acc.balance)} xuống ${money(balance)} mà không có lệnh rút`);
  }
  // Đang nghi (chưa xác nhận) thì giữ nguyên số dư cũ để mục "Đã ban" còn đúng nếu bị khoá thật
  // Acc đã đánh dấu Banned cũng giữ số dư lúc bị khoá
  const frozen = reasons.length > 0 || !!acc.suspect_reason || acc.status === 'banned';

  tx(() => {
    // --- Tài khoản ---
    db.prepare(`UPDATE accounts SET email = ?, joined_at = ?, auth_state = 'ok', last_error = '', last_sync_at = ?,
        backoff_level = 0, backoff_until = NULL, suspect_ack = 0, error_streak = 0 WHERE id = ?`)
      .run(user.email, user.joined_ts || null, now, acc.id);
    if (!frozen) {
      db.prepare('UPDATE accounts SET balance = ?, earnings_total = ? WHERE id = ?').run(balance, total, acc.id);
      upsertDaily('account_daily', 'account_id', acc.id, today, total);
    }
    if (reasons.length && !acc.suspect_reason) {
      const why = reasons.join(', ');
      db.prepare('UPDATE accounts SET suspect_reason = ?, suspect_at = ? WHERE id = ?').run(why, now, acc.id);
      addEvent({ account_id: acc.id, type: 'account_suspect', level: 'critical', message: `${accName(acc)} có dấu hiệu bị khoá: ${why}` });
      if (s.notify_suspect) alerts.push(A('account_suspect', { why, amount: acc.balance }));
    }
    if (acc.auth_state === 'expired') addEvent({ account_id: acc.id, type: 'auth', level: 'good', message: `${accName(acc)}: cookie hoạt động lại` });
    if (acc.error_streak >= Math.max(1, Number(s.error_alert_count) || 3)) {
      addEvent({ account_id: acc.id, type: 'sync_error', level: 'good', message: `${accName(acc)}: lấy dữ liệu bình thường trở lại` });
      if (s.notify_sync_error) alerts.push(A('sync_ok', { count: acc.error_streak }));
    }
    if (acc.backoff_level >= 3) addEvent({ account_id: acc.id, type: 'rate_limit', level: 'good', message: `${accName(acc)}: hết bị giới hạn, đồng bộ bình thường` });

    // --- Lưu số dư theo giờ (luôn lưu khi có bất thường) ---
    const lastSnap = db.prepare('SELECT ts, balance, earnings_total FROM balance_snapshots WHERE account_id = ? ORDER BY ts DESC LIMIT 1').get(acc.id);
    if (!lastSnap || reasons.length || now - lastSnap.ts >= 55 * 60e3) {
      db.prepare('INSERT OR REPLACE INTO balance_snapshots(account_id, ts, balance, earnings_total) VALUES (?, ?, ?, ?)').run(acc.id, now, balance, total);
    }

    // --- Máy (node) ---
    const existing = Object.fromEntries(db.prepare('SELECT * FROM devices WHERE account_id = ?').all(acc.id).map(d => [d.uuid, d]));
    const seen = new Set();
    for (const d of devices) {
      seen.add(d.uuid);
      const old = existing[d.uuid];
      const st = statuses[d.uuid];
      const dev = {
        uuid: d.uuid, title: d.title, country: d.country || '', rate: d.rate || 0,
        earned: d.earned || 0, earned_total: d.earned_total || 0,
        uptime: d.uptime || 0, total_uptime: d.total_uptime || 0, ips: JSON.stringify(d.ips || []),
        banned_reason: d.banned?.reason || null, banned_ip: d.banned?.ip || null,
        online: st ? 1 : 0, online_since: st ? st[0] : null,
        last_online_at: st ? now : old?.last_online_at || null,
        first_seen_at: old?.first_seen_at || now,
        last_earn_at: !old ? null : d.earned_total > old.earned_total ? now : old.last_earn_at,
      };
      dev.status = deviceStatus(dev, s, now);
      dev.status_changed_at = old?.status === dev.status ? old.status_changed_at : now;
      let alerted = old?.alerted || '';

      if (!firstSync && old) {
        if (alerted === 'banned' && dev.status !== 'banned') {
          // EarnApp gỡ ban: ghi lại và reset để lần bị ban sau vẫn được báo
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_unbanned', level: 'good', message: `Máy ${dev.title} hết bị ban` });
          if (s.notify_device_banned) alerts.push(A('device_unbanned', { device: dev.title }));
          alerted = '';
        }
        if (dev.status === 'banned' && alerted !== 'banned') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_banned', level: 'critical', message: `Máy ${dev.title} bị ban (${dev.banned_reason})` });
          if (s.notify_device_banned) alerts.push(A('device_banned', { device: dev.title, reason: dev.banned_reason }));
          alerted = 'banned';
        } else if (dev.status === 'offline' && dev.last_online_at && now - dev.last_online_at > s.offline_grace_min * 60e3 && alerted !== 'offline') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_offline', level: 'warning', message: `Máy ${dev.title} rớt mạng` });
          if (s.notify_offline) alerts.push(A('device_offline', { device: dev.title, last_seen: dev.last_online_at }));
          alerted = 'offline';
        } else if (dev.status === 'idle' && alerted !== 'idle') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_idle', level: 'warning', message: `Máy ${dev.title} online nhưng ${s.idle_hours}h không ra tiền` });
          if (s.notify_idle) alerts.push(A('device_idle', { device: dev.title }));
          alerted = 'idle';
        } else if (dev.status === 'online' && alerted && alerted !== 'banned') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_online', level: 'good', message: `Máy ${dev.title} hoạt động lại` });
          if (s.notify_online) alerts.push(A('device_online', { device: dev.title }));
          alerted = '';
        }
      } else if (dev.status === 'banned') {
        alerted = 'banned';
      }
      dev.alerted = alerted;

      db.prepare(`INSERT INTO devices(uuid, account_id, title, country, rate, earned, earned_total, uptime, total_uptime, ips,
          banned_reason, banned_ip, online, online_since, last_online_at, last_earn_at, status, status_changed_at, alerted, missing, first_seen_at, updated_at)
        VALUES (@uuid, @account_id, @title, @country, @rate, @earned, @earned_total, @uptime, @total_uptime, @ips,
          @banned_reason, @banned_ip, @online, @online_since, @last_online_at, @last_earn_at, @status, @status_changed_at, @alerted, 0, @first_seen_at, @updated_at)
        ON CONFLICT(uuid) DO UPDATE SET account_id = excluded.account_id, title = excluded.title, country = excluded.country, rate = excluded.rate,
          earned = excluded.earned, earned_total = excluded.earned_total, uptime = excluded.uptime, total_uptime = excluded.total_uptime, ips = excluded.ips,
          banned_reason = excluded.banned_reason, banned_ip = excluded.banned_ip, online = excluded.online, online_since = excluded.online_since,
          last_online_at = excluded.last_online_at, last_earn_at = excluded.last_earn_at, status = excluded.status,
          status_changed_at = excluded.status_changed_at, alerted = excluded.alerted, missing = 0, updated_at = excluded.updated_at`)
        .run({ ...dev, account_id: acc.id, updated_at: now });
      upsertDaily('device_daily', 'uuid', d.uuid, today, dev.earned_total);
      // Uptime: đếm số lần kiểm tra và số lần thấy online trong ngày (máy bị ban không tính)
      if (dev.status !== 'banned') {
        db.prepare('UPDATE device_daily SET check_n = check_n + 1, online_n = online_n + ? WHERE uuid = ? AND date = ?').run(dev.online, d.uuid, today);
      }
    }
    for (const uuid of Object.keys(existing)) {
      if (!seen.has(uuid)) db.prepare("UPDATE devices SET missing = 1, online = 0, status = 'offline' WHERE uuid = ?").run(uuid);
    }

    // --- Dung lượng theo ngày ---
    if (Array.isArray(usage)) {
      const up = db.prepare(`INSERT INTO device_usage(uuid, account_id, date, bytes) VALUES (?, ?, ?, ?)
        ON CONFLICT(uuid, date) DO UPDATE SET bytes = excluded.bytes, account_id = excluded.account_id`);
      for (const u of usage) {
        for (const [date, bytes] of Object.entries(u.data || {})) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number(bytes) >= 0) up.run(u._id, acc.id, date, Math.round(Number(bytes)));
        }
      }
    }

    if (Array.isArray(usageMonthly)) {
      const up = db.prepare(`INSERT INTO device_usage_monthly(uuid, account_id, month, bytes) VALUES (?, ?, ?, ?)
        ON CONFLICT(uuid, month) DO UPDATE SET bytes = excluded.bytes, account_id = excluded.account_id`);
      for (const u of usageMonthly) {
        for (const [month, bytes] of Object.entries(u.data || {})) {
          if (/^\d{4}-\d{2}$/.test(month) && Number(bytes) >= 0) up.run(u._id, acc.id, month, Math.round(Number(bytes)));
        }
      }
      db.prepare('UPDATE accounts SET usage_monthly_at = ? WHERE id = ?').run(now, acc.id);
    }

    // --- Giao dịch rút tiền ---
    for (const t of transactions || []) {
      const old = db.prepare('SELECT status FROM transactions WHERE uuid = ?').get(t.uuid);
      db.prepare(`INSERT INTO transactions(uuid, account_id, status, date, payment_method, payment_date, amount, fee, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET status = excluded.status, payment_date = excluded.payment_date, amount = excluded.amount, fee = excluded.fee, updated_at = excluded.updated_at`)
        .run(t.uuid, acc.id, t.status, t.date, t.payment_method || '', t.payment_date || null, t.money_amount || 0, t.fee_amount || 0, now);
      if (firstSync) continue;
      if (!old) {
        addEvent({ account_id: acc.id, type: 'payout_new', level: 'info', message: `${accName(acc)}: lệnh rút mới ${money(t.money_amount)} (${t.status})` });
        if (s.notify_payout) alerts.push(A('payout_new', { amount: t.money_amount, method: t.payment_method }));
      }
      if (t.status === 'paid' && old?.status !== 'paid') {
        addEvent({ account_id: acc.id, type: 'payout_paid', level: 'good', message: `${accName(acc)}: đã nhận ${money(t.money_amount)}` });
        if (s.notify_payout) alerts.push(A('payout_paid', { amount: t.money_amount, method: t.payment_method }));
      }
    }

    // --- Trạng thái tài khoản (tự động) ---
    if (acc.status !== 'banned') {
      const active = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND missing = 0 AND status IN ('online', 'idle')").get(acc.id).n;
      const status = active > 0 ? 'running' : 'stopped';
      if (status !== acc.status) {
        db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, acc.id);
        if (!firstSync) addEvent({ account_id: acc.id, type: 'account_status', level: status === 'running' ? 'good' : 'warning', message: `${accName(acc)}: ${status === 'running' ? 'đang chạy' : 'đã dừng (không còn máy online)'}` });
      }
    }
  });
  return alerts;
}

async function dailyReport(s) {
  const now = Date.now();
  const today = localDate(now, s.timezone);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, hour: '2-digit', hour12: false }).format(now));
  if (!s.daily_report || hour < s.daily_report_hour || s.last_daily_report === today) return;
  const t = summary();
  const diff = t.today - t.yesterday;
  const arrow = diff > 0.0005 ? '⬆️' : diff < -0.0005 ? '⬇️' : '➡️';
  const vnd = n => Math.round(n * s.usd_vnd).toLocaleString('vi-VN') + 'đ';
  const msg = [
    `📊 <b>Báo cáo ngày ${today.split('-').reverse().join('/')}</b>`,
    `Hôm nay: <b>${money(t.today)}</b> (${vnd(t.today)}) ${arrow} hôm qua ${money(t.yesterday)}`,
    `Tháng này: ${money(t.month)} (${vnd(t.month)})`,
    '',
    `🟢 ${t.devices.online} chạy · 🟡 ${t.devices.idle} không ra tiền · 🔴 ${t.devices.offline} rớt · ⚪ ${t.devices.banned} bị ban`,
    `Acc: ${t.accounts.running} chạy · ${t.accounts.stopped} dừng · ${t.accounts.banned} bị khoá`,
    '',
    `📶 Dung lượng hôm nay: ${fmtBytes(t.usage_today)} · 7 ngày: ${fmtBytes(t.usage_7d)}`,
    '',
    `💰 Số dư hiện tại: ${money(t.current)}`,
    `💵 Đã rút: ${money(t.withdrawn)}${t.pending_count ? ` · đang chờ ${money(t.pending)}` : ''}`,
    `📈 Tổng lifetime: ${money(t.lifetime)}`,
  ];
  if (t.accounts.auth_problems) msg.push('', `🔑 ${t.accounts.auth_problems} acc cần cập nhật cookie`);
  await sendTelegram(msg.join('\n'), s);
  setSettings({ last_daily_report: today });
}

// ================== Lập lịch ==================
// Mỗi acc có lịch riêng: lấy xong thì hẹn lần tới ngẫu nhiên trong [sync_min_min, sync_max_min] phút.
// Tại một thời điểm chỉ gọi 1 acc, giữa 2 acc cách nhau ít nhất account_delay_sec giây,
// nên các acc được rải đều theo thời gian thay vì dồn một loạt.

const rand = (a, b) => a + Math.random() * (b - a);

export function nextDelayMs(s) {
  const lo = Math.max(1, Number(s.sync_min_min) || 5);
  const hi = Math.max(lo, Number(s.sync_max_min) || lo);
  return rand(lo, hi) * 60e3;
}

// Khoá: chỉ đồng bộ 1 acc mỗi lúc (lịch tự động và bấm tay dùng chung)
let lock = Promise.resolve();
export function withLock(fn) {
  const r = lock.then(fn, fn);
  lock = r.catch(() => {});
  return r;
}

export const alertQueue = [];
let directPauseUntil = 0; // IP server bị giới hạn: tạm dừng các acc không dùng proxy tới lúc này

const ALERT_QUEUE_MAX = 500;

export async function flushAlerts(s) {
  if (!alertQueue.length) return;
  const list = alertQueue.splice(0);
  try {
    await sendTelegram(formatAlerts(list, s), s);
  } catch (e) {
    // Gửi lỗi (mạng chập chờn, Telegram lỗi): trả lại hàng chờ, phút sau gửi lại. Giữ tối đa 500 cảnh báo mới nhất.
    console.error('telegram', e.message);
    alertQueue.unshift(...list);
    if (alertQueue.length > ALERT_QUEUE_MAX) alertQueue.splice(0, alertQueue.length - ALERT_QUEUE_MAX);
  }
}

/** Đồng bộ 1 acc rồi hẹn lần tới */
async function syncOne(id, s) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) return [];
  syncState.running = true;
  syncState.current = acc.id;
  let next = Date.now() + nextDelayMs(s);
  try {
    const r = await syncAccount(acc, s);
    alertQueue.push(...r);
    if (r.rateLimited) {
      const until = db.prepare('SELECT backoff_until FROM accounts WHERE id = ?').get(acc.id).backoff_until || next;
      next = Math.max(next, until);
      if (!acc.proxy) directPauseUntil = Math.max(directPauseUntil, until);
    }
    syncState.lastCycleAt = Date.now();
    return r;
  } catch (e) {
    console.error('sync', acc.id, e);
    return [];
  } finally {
    db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(Math.round(next), acc.id);
    const t = new Date().toLocaleTimeString('vi-VN', { timeZone: s.timezone });
    console.log(`[${t}] ${accName(acc)}: đã lấy dữ liệu, lần tới sau ${((next - Date.now()) / 60e3).toFixed(1)} phút`);
    syncState.running = false;
    syncState.current = null;
  }
}

/** Acc tới lượt (đã tới giờ hẹn, không bị giới hạn), lâu nhất trước */
export function pickDue(now = Date.now()) {
  const list = db.prepare(`SELECT id, proxy FROM accounts
    WHERE paused = 0 AND (next_sync_at IS NULL OR next_sync_at <= ?) AND (backoff_until IS NULL OR backoff_until <= ?)
    ORDER BY COALESCE(next_sync_at, 0), id`).all(now, now);
  return list.find(a => a.proxy || directPauseUntil <= now) || null;
}

/** Khi khởi động: các acc quá hạn (server tắt một lúc) được rải ngẫu nhiên, không gọi dồn */
export function spreadOverdue(now = Date.now(), s = getSettings()) {
  const late = db.prepare('SELECT id FROM accounts WHERE paused = 0 AND (next_sync_at IS NULL OR next_sync_at <= ?)').all(now);
  const span = Math.max(1, Number(s.sync_min_min) || 5) * 60e3;
  const up = db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?');
  for (const a of late) up.run(Math.round(now + Math.random() * span), a.id);
  return late.length;
}

/** Nút "Đồng bộ ngay" (tất cả): xếp hàng các acc cách nhau đúng khoảng nghỉ tối thiểu */
export function requestSyncAll(s = getSettings()) {
  const list = db.prepare('SELECT id FROM accounts WHERE paused = 0 AND (backoff_until IS NULL OR backoff_until <= ?) ORDER BY id').all(Date.now());
  const up = db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?');
  list.forEach((a, i) => up.run(Date.now() + i * s.account_delay_sec * 1000, a.id));
  return list.length;
}

/** Đồng bộ ngay các acc chỉ định (thêm acc, bấm Cập nhật). Không truyền ids = tất cả acc tới lượt */
export async function runCycle(ids = null) {
  const s = getSettings();
  const list = ids || db.prepare(`SELECT id FROM accounts WHERE paused = 0 AND (backoff_until IS NULL OR backoff_until <= ?) ORDER BY id`)
    .all(Date.now()).map(a => a.id);
  for (const [i, id] of list.entries()) {
    const acc = db.prepare('SELECT proxy FROM accounts WHERE id = ?').get(id);
    if (!ids && acc && !acc.proxy && directPauseUntil > Date.now()) continue;
    await withLock(() => syncOne(id, s));
    if (i < list.length - 1) await sleep(s.account_delay_sec * 1000 * rand(0.7, 1.3));
  }
  await flushAlerts(s);
  return true;
}

let lastCleanup = '';
function cleanup(s) {
  const today = localDate(Date.now(), s.timezone);
  if (lastCleanup === today) return;
  lastCleanup = today;
  db.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - 90 * 864e5);
  db.prepare('DELETE FROM device_daily WHERE date < ?').run(addDays(today, -400));
  db.prepare('DELETE FROM balance_snapshots WHERE ts < ?').run(Date.now() - 400 * 864e5);
  db.prepare('DELETE FROM device_usage WHERE date < ?').run(addDays(today, -400));
}

export function startScheduler() {
  spreadOverdue();
  const loop = async () => {
    const s = getSettings();
    let wait = 5000;
    try {
      const due = pickDue();
      if (due) {
        await withLock(() => syncOne(due.id, s));
        wait = s.account_delay_sec * 1000 * rand(0.7, 1.3);
      } else {
        const n = db.prepare('SELECT MIN(next_sync_at) AS t FROM accounts WHERE paused = 0').get().t;
        syncState.nextCycleAt = n;
        // Ngủ tới lượt kế tiếp, nhưng tối đa 5 giây để kịp thấy acc mới / cài đặt mới
        wait = n ? Math.min(Math.max(n - Date.now(), 500), 5000) : 5000;
      }
    } catch (e) {
      console.error('scheduler', e);
    }
    setTimeout(loop, wait);
  };
  setTimeout(loop, 2000);
  // Gom cảnh báo gửi Telegram mỗi phút, tránh spam từng tin
  setInterval(() => {
    const s = getSettings();
    flushAlerts(s);
    dailyReport(s).catch(e => console.error('daily report', e.message));
    cleanup(s);
  }, 60e3);
}
