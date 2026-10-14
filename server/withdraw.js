import { db, getSettings, addEvent } from './db.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { EarnAppClient, AuthError, NetworkError, RateLimitError } from './earnapp.js';
import { localDate, addDays } from './stats.js';
import { withLock, alertQueue, flushAlerts } from './sync.js';

// ================== Hẹn giờ rút tiền tự động ==================
// EarnApp chỉ cho rút TOÀN BỘ số dư: POST /api/redeem {to, payment_method}.
// Mỗi acc 1 lịch: rút 1 lần vào ngày giờ cụ thể, hoặc lặp lại hằng tuần vào các thứ đã chọn.

// Mức tối thiểu lấy từ EarnApp (payment_methods) lúc rút; số ở đây chỉ để hiển thị và dự phòng
export const PAYOUT_METHODS = [
  { id: 'paypal.com', name: 'PayPal', min: 10, fee: 'phí 2%' },
  { id: 'wise.com', name: 'Wise', min: 10, fee: 'phí $1.13' },
  { id: 'amazon.com (US/Global)', name: 'Amazon Gift Card (US/Global)', min: 50 },
  { id: 'amazon.de (Germany)', name: 'Amazon Gift Card (Đức)', min: 50 },
  { id: 'amazon.co.uk (UK)', name: 'Amazon Gift Card (Anh)', min: 50 },
  { id: 'amazon.com.tr (Turkey)', name: 'Amazon Gift Card (Thổ Nhĩ Kỳ)', min: 50 },
];
export const methodLabel = id => PAYOUT_METHODS.find(m => m.id === id)?.name || id;

const RETRY_MAX = 3;            // lỗi mạng / bị giới hạn: thử lại tối đa 3 lần
const RETRY_GAP = 10 * 60e3;    // cách nhau 10 phút
const LATE_MAX = 24 * 3600e3;   // server tắt quá 24h làm lỡ giờ hẹn thì bỏ qua lần đó, không rút vào giờ bất kỳ
export const payoutAllowed = email => config.payoutEmails.includes(String(email || '').trim().toLowerCase());
const NOT_ALLOWED = 'Email nhận tiền không nằm trong danh sách được phép (PAYOUT_EMAILS trong file .env trên máy chủ)';

const money = n => '$' + (Number(n) || 0).toFixed(2);
const accName = a => a.label || a.email || `Acc #${a.id}`;

// ---------- Giờ theo múi giờ cài đặt ----------
function tzOffset(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** "2026-10-14" + "10:00" theo múi giờ tz -> mốc thời gian (ms) */
export function zonedTs(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ts = wall;
  for (let i = 0; i < 2; i++) ts = wall - tzOffset(ts, tz);
  return ts;
}

const weekdayOf = date => new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Chủ nhật
export const parseWeekdays = s => String(s || '').split(',').filter(x => /^[0-6]$/.test(x)).map(Number);

/** Lần chạy kế tiếp sau mốc `after`. Không còn lần nào (rút 1 lần đã qua) -> null */
export function nextRunAt(sch, after, tz) {
  if (sch.mode === 'once') {
    const ts = zonedTs(sch.run_date, sch.time, tz);
    return ts > after ? ts : null;
  }
  const days = parseWeekdays(sch.weekdays);
  if (!days.length) return null;
  const today = localDate(after, tz);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    if (!days.includes(weekdayOf(date))) continue;
    const ts = zonedTs(date, sch.time, tz);
    if (ts > after) return ts;
  }
  return null;
}

/** Kiểm tra dữ liệu lịch người dùng nhập. Trả về lịch đã chuẩn hoá, sai thì báo lỗi */
export function validateSchedule(b, now = Date.now(), tz = getSettings().timezone) {
  const sch = {
    mode: b.mode === 'once' ? 'once' : 'weekly',
    run_date: b.mode === 'once' ? String(b.run_date || '') : null,
    weekdays: b.mode === 'once' ? '' : [...new Set(parseWeekdays(Array.isArray(b.weekdays) ? b.weekdays.join(',') : b.weekdays))].sort().join(','),
    time: String(b.time || ''),
    method: String(b.method || ''),
    email: String(b.email || '').trim(),
    enabled: b.enabled === false ? 0 : 1,
  };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sch.time)) throw new Error('Giờ rút không hợp lệ (VD: 10:00)');
  if (!PAYOUT_METHODS.some(m => m.id === sch.method)) throw new Error('Chưa chọn phương thức rút');
  if (!config.payoutEmails.length) throw new Error('Chưa cài danh sách email nhận tiền: thêm PAYOUT_EMAILS vào file .env trên máy chủ rồi khởi động lại web');
  if (!payoutAllowed(sch.email)) throw new Error(NOT_ALLOWED);
  sch.email = sch.email.toLowerCase();
  if (sch.mode === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sch.run_date)) throw new Error('Chưa chọn ngày rút');
    if (sch.enabled && zonedTs(sch.run_date, sch.time, tz) <= now) throw new Error('Thời điểm rút đã qua, chọn ngày giờ khác');
  } else if (!sch.weekdays) {
    throw new Error('Chọn ít nhất 1 thứ trong tuần');
  }
  sch.next_run_at = sch.enabled ? nextRunAt(sch, now, tz) : null;
  return sch;
}

const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
/** "1 lần 10:00 14/10/2026" / "hằng tuần 15:00 T5" */
export function describeSchedule(sch) {
  if (sch.mode === 'once') return `1 lần ${sch.time} ${sch.run_date.split('-').reverse().join('/')}`;
  return `hằng tuần ${sch.time} ${parseWeekdays(sch.weekdays).sort((x, y) => (x || 7) - (y || 7)).map(d => WD[d]).join(', ')}`;
}

export function saveSchedule(accountId, body) {
  const sch = validateSchedule(body);
  db.prepare(`INSERT INTO withdraw_schedules(account_id, mode, run_date, weekdays, time, method, email, enabled, next_run_at, attempts, created_at)
      VALUES (@account_id, @mode, @run_date, @weekdays, @time, @method, @email, @enabled, @next_run_at, 0, @now)
    ON CONFLICT(account_id) DO UPDATE SET mode = excluded.mode, run_date = excluded.run_date, weekdays = excluded.weekdays, time = excluded.time,
      method = excluded.method, email = excluded.email, enabled = excluded.enabled, next_run_at = excluded.next_run_at, attempts = 0`)
    .run({ ...sch, account_id: accountId, now: Date.now() });
  return sch;
}

function log(acc, sch, status, message, amount = null) {
  db.prepare('INSERT INTO withdraw_log(account_id, ts, status, amount, method, email, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(acc.id, Date.now(), status, amount, sch.method, sch.email, message);
}

/**
 * Rút toàn bộ số dư 1 acc theo lịch đã lưu.
 * Trả về { status: ok | failed | skipped | retry, message, amount }
 */
async function redeem(acc, sch) {
  if (acc.archived_at) return { status: 'failed', message: 'Acc đang lưu trữ' };
  if (acc.status === 'banned') return { status: 'failed', message: 'Acc đã bị khoá' };
  // Kiểm tra lại lúc rút: email bị gỡ khỏi .env sau khi hẹn thì không rút
  if (!payoutAllowed(sch.email)) return { status: 'failed', message: NOT_ALLOWED };
  const client = new EarnAppClient(decrypt(acc.cookie_enc), acc.proxy);
  const m = await client.call('money');
  const balance = Number(m.balance) || 0;
  let meta = PAYOUT_METHODS.find(x => x.id === sch.method);
  try {
    const live = (await client.call('payment_methods'))?.[sch.method];
    if (live?.disabled) return { status: 'failed', message: `EarnApp đang tắt phương thức ${methodLabel(sch.method)}` };
    if (live?.min_redeem) meta = { ...meta, min: live.min_redeem };
  } catch (e) { if (e instanceof AuthError) throw e; }
  if (balance < meta.min) {
    return { status: 'skipped', message: `Số dư ${money(balance)} chưa đủ mức rút tối thiểu ${money(meta.min)} của ${methodLabel(sch.method)}`, amount: balance };
  }
  const r = await client.call('redeem', { method: 'POST', body: { to: sch.email, payment_method: sch.method } });
  if (r && typeof r === 'object' && r.error) return { status: 'failed', message: `EarnApp từ chối: ${r.error}`, amount: balance };
  return { status: 'ok', message: `Đã tạo lệnh rút ${money(balance)} qua ${methodLabel(sch.method)} tới ${sch.email}`, amount: balance };
}

const running = new Set();

/** Chạy lệnh rút cho 1 acc. manual = bấm "Rút ngay" (không đổi lịch hẹn) */
export async function runWithdraw(accountId, { manual = false } = {}) {
  if (running.has(accountId)) return { status: 'failed', message: 'Acc này đang rút, chờ chút' };
  running.add(accountId);
  try {
    return await withLock(() => runLocked(accountId, manual));
  } finally {
    running.delete(accountId);
  }
}

async function runLocked(accountId, manual) {
  const s = getSettings();
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  const sch = db.prepare('SELECT * FROM withdraw_schedules WHERE account_id = ?').get(accountId);
  if (!acc || !sch) return { status: 'failed', message: 'Chưa cài phương thức và email nhận tiền cho acc này' };
  const now = Date.now();

  let res;
  try {
    res = await redeem(acc, sch);
  } catch (e) {
    const temporary = e instanceof NetworkError || e instanceof RateLimitError;
    if (!manual && temporary && sch.attempts + 1 < RETRY_MAX) {
      db.prepare('UPDATE withdraw_schedules SET attempts = attempts + 1, next_run_at = ?, last_status = ?, last_message = ? WHERE account_id = ?')
        .run(now + RETRY_GAP, 'retry', `${e.message}. Thử lại sau 10 phút (lần ${sch.attempts + 2}/${RETRY_MAX})`, accountId);
      return { status: 'retry', message: e.message };
    }
    res = { status: 'failed', message: e instanceof AuthError ? 'Cookie hết hạn, cập nhật cookie mới rồi rút lại' : e.message };
  }

  log(acc, sch, res.status, res.message, res.amount);
  const upd = { last_run_at: now, last_status: res.status, last_message: res.message, attempts: 0 };
  if (!manual) {
    // Rút 1 lần: xong thì tắt lịch. Hằng tuần: hẹn lần kế tiếp
    if (sch.mode === 'once') Object.assign(upd, { enabled: 0, next_run_at: null });
    else upd.next_run_at = nextRunAt(sch, now + 60e3, s.timezone);
  }
  db.prepare(`UPDATE withdraw_schedules SET ${Object.keys(upd).map(k => `${k} = @${k}`).join(', ')} WHERE account_id = @account_id`).run({ ...upd, account_id: accountId });

  const level = { ok: 'good', skipped: 'warning', failed: 'critical' }[res.status];
  addEvent({ account_id: acc.id, type: 'withdraw_' + res.status, level, message: `${accName(acc)}: ${manual ? 'rút ngay' : 'rút theo lịch'}: ${res.message}` });
  if (s.notify_withdraw) {
    alertQueue.push({ type: 'withdraw_' + res.status, ts: now, account_id: acc.id, label: acc.label, email: acc.email,
      amount: res.amount, why: res.message, method: sch.method, to: sch.email });
    flushAlerts(s).catch(() => {});
  }
  // Lấy dữ liệu acc sớm để thấy lệnh rút mới trong mục Rút tiền
  if (res.status === 'ok') db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(now + 90e3, acc.id);
  return res;
}

/** Báo Telegram ngay mỗi khi lịch rút bị tạo / sửa / bật / tắt / xoá hoặc bấm Rút ngay (bất kể cài đặt thông báo) */
export function notifyChange(accountIds, what, ip) {
  const s = getSettings();
  const now = Date.now();
  for (const id of accountIds) {
    const acc = db.prepare('SELECT id, label, email FROM accounts WHERE id = ?').get(id);
    if (!acc) continue;
    addEvent({ account_id: acc.id, type: 'withdraw_changed', level: 'warning', message: `${accName(acc)}: ${what} (IP ${ip})` });
    alertQueue.push({ type: 'withdraw_changed', ts: now, account_id: acc.id, label: acc.label, email: acc.email, why: what, ip });
  }
  flushAlerts(s).catch(() => {});
}

/** Gọi mỗi 30 giây: chạy các lịch đã tới giờ */
export async function checkDueWithdrawals(now = Date.now()) {
  const tz = getSettings().timezone;
  const due = db.prepare('SELECT * FROM withdraw_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at').all(now);
  for (const sch of due) {
    if (now - sch.next_run_at > LATE_MAX && sch.attempts === 0) {
      // Server tắt quá lâu, lỡ giờ hẹn: không rút bù vào giờ bất kỳ
      const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(sch.account_id);
      const msg = 'Lỡ giờ hẹn vì web không chạy lúc đó';
      log(acc, sch, 'missed', msg);
      db.prepare('UPDATE withdraw_schedules SET last_status = ?, last_message = ?, enabled = ?, next_run_at = ? WHERE account_id = ?')
        .run('missed', msg, sch.mode === 'once' ? 0 : 1, sch.mode === 'once' ? null : nextRunAt(sch, now, tz), sch.account_id);
      addEvent({ account_id: sch.account_id, type: 'withdraw_missed', level: 'warning', message: `${accName(acc)}: ${msg.toLowerCase()}` });
      continue;
    }
    await runWithdraw(sch.account_id).catch(e => console.error('withdraw', sch.account_id, e));
  }
}

/** Đổi múi giờ trong Cài đặt: tính lại giờ hẹn các lịch hằng tuần */
export function recomputeSchedules(tz = getSettings().timezone, now = Date.now()) {
  for (const sch of db.prepare('SELECT * FROM withdraw_schedules WHERE enabled = 1 AND attempts = 0').all()) {
    db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = ?').run(nextRunAt(sch, now, tz), sch.account_id);
  }
}

export function startWithdrawScheduler() {
  setInterval(() => checkDueWithdrawals().catch(e => console.error('withdraw scheduler', e)), 30e3);
}
