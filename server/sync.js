import { db, getSettings, setSettings, addEvent, tx } from './db.js';
import { decrypt } from './crypto.js';
import { EarnAppClient, AuthError, BannedError, RateLimitError } from './earnapp.js';
import { sendTelegram } from './telegram.js';
import { fullName } from './accname.js';
import { formatAlerts } from './alerts.js';
import { formatDailyReport } from './dailyReport.js';
import { localDate, addDays, staleMs } from './stats.js';
import { config } from './config.js';

const money = n => '$' + (n || 0).toFixed(2);
const accName = fullName;

export const syncState = { running: false, current: null, lastCycleAt: null, nextCycleAt: null };

// Tiến độ lấy dữ liệu từng acc, để giao diện hiện % khi vừa thêm acc / bấm đồng bộ.
// Chỉ giữ trong bộ nhớ; acc xong rồi giữ thêm 10 phút.
const progress = new Map();
let avgSyncMs = 20e3; // thời gian lấy 1 acc trung bình, dùng ước tính lúc chờ tới lượt
const setProgress = (id, p) => progress.set(id, { ...progress.get(id), ...p });

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

// Cả acc không node nào tăng tiền (EarnApp chưa cập nhật, hoặc acc kiếm quá ít nên vài giờ mới nhích $0.001):
// chỉ coi 1 node là "lâu không tăng tiền" khi đứng yên lâu hơn hẳn, tránh báo nhầm hàng loạt
const IDLE_FLAT_MIN_HOURS = 24;
export const idleHours = (s, peerEarning) => peerEarning ? Number(s.idle_hours) : Math.max(IDLE_FLAT_MIN_HOURS, Number(s.idle_hours) * 4);

/** peerEarning: có node KHÁC cùng acc vừa tăng tiền trong idle_hours giờ qua */
function deviceStatus(dev, s, now, peerEarning) {
  if (dev.banned_reason) return 'banned';
  if (!dev.online) return 'offline';
  // Online nhưng không tăng tiền quá lâu -> idle (vàng)
  const ref = Math.max(dev.last_earn_at || 0, dev.online_since || now, dev.first_seen_at || now);
  return now - ref > idleHours(s, peerEarning) * 3600e3 ? 'idle' : 'online';
}

/** Đồng bộ 1 tài khoản. Trả về danh sách dòng cảnh báo cho Telegram. */
export async function syncAccount(acc, s = getSettings(), { onStep } = {}) {
  const alerts = [];
  const now = Date.now();
  const firstSync = !acc.last_sync_at;
  // Mỗi cảnh báo mang đủ thông tin acc để soạn tin rõ ràng (gom theo acc khi gửi)
  const A = (type, extra = {}) => ({ type, ts: now, account_id: acc.id, label: acc.label, email: acc.email, ...extra });
  const client = new EarnAppClient(decrypt(acc.cookie_enc), acc.proxy);

  let data;
  try {
    // Số liệu tháng ít thay đổi: chỉ lấy mỗi giờ 1 lần để đỡ gọi EarnApp
    data = await client.fetchAll({ withMonthly: !acc.usage_monthly_at || now - acc.usage_monthly_at > 3600e3, onStep });
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
        if (s.notify_sync_error) alerts.push(A('sync_error', { why: msg, count: streak, proxy: !!acc.proxy, since: acc.last_ok_at }));
      }
    }
    return alerts;
  }

  const { user, money: m, devices, transactions, usage, usageMonthly } = data;
  let { statuses } = data;

  // Trạng thái node rỗng trong khi lần trước còn node online: có thể EarnApp lỗi thoáng qua.
  // Lần đầu gặp thì giữ trạng thái cũ, chỉ tin "tất cả rớt" khi 2 lần liên tiếp đều rỗng.
  let emptyStreak = 0;
  if (devices.length && !Object.keys(statuses).length) {
    emptyStreak = (acc.empty_status_streak || 0) + 1;
    const prevOnline = db.prepare("SELECT uuid, online_since FROM devices WHERE account_id = ? AND missing = 0 AND online = 1").all(acc.id);
    if (prevOnline.length && emptyStreak < 2) {
      statuses = Object.fromEntries(prevOnline.map(d => [d.uuid, [d.online_since, 0]]));
      console.warn(`${accName(acc)}: EarnApp trả trạng thái node rỗng, tạm giữ trạng thái cũ`);
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
    if (prevDevices > 0 && devices.length === 0) reasons.push(`tất cả ${prevDevices} node biến mất`);
    if (total < acc.earnings_total - 0.01) reasons.push(`tổng kiếm giảm từ ${money(acc.earnings_total)} xuống ${money(total)}`);
    else if (balance < acc.balance - 0.01 && !newPayout) reasons.push(`số dư giảm từ ${money(acc.balance)} xuống ${money(balance)} mà không có lệnh rút`);
  }
  // Đang nghi (chưa xác nhận) thì giữ nguyên số dư cũ để mục "Đã ban" còn đúng nếu bị khoá thật
  // Acc đã đánh dấu Banned cũng giữ số dư lúc bị khoá
  const frozen = reasons.length > 0 || !!acc.suspect_reason || acc.status === 'banned';

  tx(() => {
    // --- Tài khoản ---
    db.prepare(`UPDATE accounts SET email = ?, joined_at = ?, auth_state = 'ok', last_error = '', last_sync_at = ?, last_ok_at = ?,
        backoff_level = 0, backoff_until = NULL, suspect_ack = 0, error_streak = 0 WHERE id = ?`)
      .run(user.email, user.joined_ts || null, now, now, acc.id);
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
    // --- Thông tin nhận tiền (Auto-redeem) trên EarnApp: bị đổi thì báo ngay, phòng lộ cookie ---
    if (m && 'redeem_details' in m) {
      const rd = m.redeem_details ? { email: String(m.redeem_details.email || ''), payment_method: String(m.redeem_details.payment_method || '') } : null;
      const json = rd ? JSON.stringify(rd) : '';
      if (json !== (acc.redeem_details ?? json)) {
        const old = acc.redeem_details ? JSON.parse(acc.redeem_details) : null;
        const foreign = !!rd && rd.email.toLowerCase() !== String(user.email || acc.email || '').toLowerCase() && !config.payoutEmails.includes(rd.email.toLowerCase());
        addEvent({ account_id: acc.id, type: 'redeem_details', level: rd ? 'critical' : 'info',
          message: rd ? `${accName(acc)}: thông tin nhận tiền trên EarnApp đổi thành ${rd.payment_method} → ${rd.email}` : `${accName(acc)}: Auto-redeem trên EarnApp đã tắt` });
        alerts.push(A('redeem_details_changed', { old, new: rd, foreign }));
      }
      db.prepare('UPDATE accounts SET redeem_details = ? WHERE id = ?').run(json, acc.id);
    }
    if (acc.backoff_level >= 3) addEvent({ account_id: acc.id, type: 'rate_limit', level: 'good', message: `${accName(acc)}: hết bị giới hạn, đồng bộ bình thường` });

    // --- Lưu số dư theo giờ (luôn lưu khi có bất thường) ---
    const lastSnap = db.prepare('SELECT ts, balance, earnings_total FROM balance_snapshots WHERE account_id = ? ORDER BY ts DESC LIMIT 1').get(acc.id);
    if (!lastSnap || reasons.length || now - lastSnap.ts >= 55 * 60e3) {
      db.prepare('INSERT OR REPLACE INTO balance_snapshots(account_id, ts, balance, earnings_total) VALUES (?, ?, ?, ?)').run(acc.id, now, balance, total);
    }

    // --- Node (thiết bị EarnApp trong acc, mỗi node thường chạy 1 proxy) ---
    const existing = Object.fromEntries(db.prepare('SELECT * FROM devices WHERE account_id = ?').all(acc.id).map(d => [d.uuid, d]));
    const seen = new Set();
    // Lần tăng tiền gần nhất của từng node, để biết các node khác trong acc có đang ra tiền không
    const lastEarnOf = d => { const old = existing[d.uuid]; return !old ? null : d.earned_total > old.earned_total ? now : old.last_earn_at; };
    const recentEarners = new Set(devices.filter(d => (lastEarnOf(d) || 0) > now - s.idle_hours * 3600e3).map(d => d.uuid));
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
        last_earn_at: lastEarnOf(d),
      };
      const peerEarning = recentEarners.size > (recentEarners.has(d.uuid) ? 1 : 0);
      dev.status = deviceStatus(dev, s, now, peerEarning);
      dev.status_changed_at = old?.status === dev.status ? old.status_changed_at : now;
      let alerted = old?.alerted || '';

      if (!firstSync && old) {
        if (alerted === 'banned' && dev.status !== 'banned') {
          // EarnApp gỡ ban: ghi lại và reset để lần bị ban sau vẫn được báo
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_unbanned', level: 'good', message: `Node ${dev.title} hết bị ban` });
          if (s.notify_device_banned) alerts.push(A('device_unbanned', { device: dev.title }));
          alerted = '';
        }
        if (dev.status === 'banned' && alerted !== 'banned') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_banned', level: 'critical', message: `Node ${dev.title} bị ban (${dev.banned_reason})` });
          if (s.notify_device_banned) alerts.push(A('device_banned', { device: dev.title, reason: dev.banned_reason }));
          alerted = 'banned';
        } else if (dev.status === 'offline' && dev.last_online_at && now - dev.last_online_at > s.offline_grace_min * 60e3 && alerted !== 'offline') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_offline', level: 'warning', message: `Node ${dev.title} rớt mạng` });
          if (s.notify_offline) alerts.push(A('device_offline', { device: dev.title, last_seen: dev.last_online_at }));
          alerted = 'offline';
        } else if (dev.status === 'idle' && alerted !== 'idle') {
          const hours = idleHours(s, peerEarning);
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_idle', level: 'warning', message: `Node ${dev.title} online nhưng ${hours}h không tăng tiền` });
          if (s.notify_idle) alerts.push(A('device_idle', { device: dev.title, hours }));
          alerted = 'idle';
        } else if (dev.status === 'online' && alerted === 'idle' && dev.last_earn_at === old.last_earn_at) {
          // Hết "lâu không tăng tiền" chỉ vì đổi ngưỡng / node vừa kết nối lại, chưa tăng đồng nào: chưa báo "chạy lại"
        } else if (dev.status === 'online' && alerted && alerted !== 'banned') {
          addEvent({ account_id: acc.id, device_uuid: d.uuid, type: 'device_online', level: 'good', message: `Node ${dev.title} hoạt động lại` });
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
      // Uptime: đếm số lần kiểm tra và số lần thấy online trong ngày (node bị ban không tính)
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
        // Lệnh do web vừa tạo (Rút ngay / theo lịch) đã có tin "Đã gửi lệnh rút": không báo lại.
        // Lệnh tạo ngoài web (trên EarnApp, Auto-redeem) vẫn báo để phòng lộ cookie.
        const fromWeb = db.prepare("SELECT 1 FROM withdraw_log WHERE account_id = ? AND status = 'ok' AND ts > ? AND ABS(amount - ?) < 0.02")
          .get(acc.id, now - 6 * 3600e3, t.money_amount || 0);
        if (s.notify_payout && !fromWeb) alerts.push(A('payout_new', { amount: t.money_amount, method: t.payment_method }));
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
        if (!firstSync) addEvent({ account_id: acc.id, type: 'account_status', level: status === 'running' ? 'good' : 'warning', message: `${accName(acc)}: ${status === 'running' ? 'đang chạy' : 'đã dừng (không còn node online)'}` });
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
  await sendTelegram(formatDailyReport(s, now), s);
  setSettings({ last_daily_report: today });
}

// ================== Lập lịch ==================
// Mỗi acc có lịch riêng: lấy xong thì hẹn lần tới ngẫu nhiên trong [sync_min_min, sync_max_min] phút.
// Chạy song song tối đa max_parallel acc, nhưng mỗi đường ra (1 proxy, hoặc IP server khi acc không có proxy)
// chỉ 1 acc mỗi lúc, xong thì đường đó nghỉ account_delay_sec giây mới gọi acc tiếp.
// Vậy mỗi IP vẫn gọi EarnApp thưa như trước, còn các acc khác proxy không phải xếp hàng chờ nhau.

const rand = (a, b) => a + Math.random() * (b - a);

export function nextDelayMs(s) {
  const lo = Math.max(1, Number(s.sync_min_min) || 5);
  const hi = Math.max(lo, Number(s.sync_max_min) || lo);
  return rand(lo, hi) * 60e3;
}

// Số acc lấy cùng lúc: chỉnh trong Cài đặt (max_parallel), giới hạn 1–PARALLEL_LIMIT
export const PARALLEL_LIMIT = 20;
export const maxParallel = (s = getSettings()) => Math.min(PARALLEL_LIMIT, Math.max(1, Math.round(Number(s.max_parallel) || 1)));
let active = 0;
const busyAccounts = new Set();
const busyRoutes = new Map(); // đường ra -> lúc được dùng lại (Infinity = đang gọi)
const pending = new Set(); // acc đã xếp hàng (runCycle) chưa chạy xong: lịch tự động không lấy trùng
const routeOf = proxy => proxy || '';
const routeOfId = id => routeOf(db.prepare('SELECT proxy FROM accounts WHERE id = ?').get(id)?.proxy);

function take(id, route, now = Date.now()) {
  if (active >= maxParallel() || busyAccounts.has(id) || (busyRoutes.get(route) ?? 0) > now) return false;
  active++;
  busyAccounts.add(id);
  busyRoutes.set(route, Infinity);
  return true;
}

const waiters = new Set();
// Chờ tới khi có chỗ trống: được gọi dậy khi 1 acc xong, hoặc tự xét lại sau 0,5 giây (đường ra hết giờ nghỉ)
const waitTurn = () => new Promise(r => {
  const done = () => { waiters.delete(done); clearTimeout(t); r(); };
  const t = setTimeout(done, 500);
  waiters.add(done);
});

async function runTaken(id, route, fn) {
  syncState.running = true;
  syncState.current = id;
  try { return await fn(); } finally {
    active--;
    busyAccounts.delete(id);
    busyRoutes.set(route, Date.now() + (Number(getSettings().account_delay_sec) || 0) * 1000 * rand(0.7, 1.3));
    syncState.running = active > 0;
    if (!active) syncState.current = null;
    for (const w of [...waiters]) w();
  }
}

/** Chạy fn cho 1 acc khi tới lượt: không trùng acc, mỗi đường ra 1 acc, tổng tối đa max_parallel (đồng bộ, rút tiền dùng chung) */
export async function withLock(fn, id) {
  const route = routeOfId(id);
  await null; // luôn chờ lượt bất đồng bộ, như trước
  while (!take(id, route)) await waitTurn();
  return runTaken(id, route, fn);
}

export const alertQueue = [];
let directPauseUntil = 0; // IP server bị giới hạn: tạm dừng các acc không dùng proxy tới lúc này

const ALERT_QUEUE_MAX = 500;

export async function flushAlerts(s) {
  if (!alertQueue.length) return;
  const list = alertQueue.splice(0);
  try {
    // Gắn máy hiện tại của acc để tin gom theo máy -> acc -> node
    const machine = new Map(db.prepare('SELECT id, group_name FROM accounts').all().map(r => [r.id, r.group_name || '']));
    await sendTelegram(formatAlerts(list.map(a => ({ ...a, group_name: machine.get(a.account_id) ?? a.group_name })), s), s);
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
  if (!acc) { progress.delete(id); return []; }
  const started = Date.now();
  setProgress(id, { state: 'running', percent: 0, step: 'Đang kết nối EarnApp', started_at: started });
  // Lấy dữ liệu chiếm 0–95%, phần còn lại là lưu vào database
  const onStep = (frac, step) => setProgress(id, { percent: Math.round(frac * 95), step });
  let next = Date.now() + nextDelayMs(s);
  try {
    const r = await syncAccount(acc, s, { onStep });
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
    const after = db.prepare('SELECT last_ok_at, last_error FROM accounts WHERE id = ?').get(acc.id);
    const ok = (after?.last_ok_at || 0) >= started;
    if (ok) avgSyncMs = avgSyncMs * 0.7 + (Date.now() - started) * 0.3;
    setProgress(id, ok
      ? { state: 'done', percent: 100, step: 'Đã tải xong', finished_at: Date.now() }
      : { state: 'error', step: 'Lấy dữ liệu lỗi', error: after?.last_error || 'Không rõ lỗi', finished_at: Date.now() });
    const t = new Date().toLocaleTimeString('vi-VN', { timeZone: s.timezone });
    const when = `lần tới sau ${((next - Date.now()) / 60e3).toFixed(1)} phút`;
    console.log(`[${t}] ${accName(acc)}: ${ok ? 'đã lấy dữ liệu' : `LỖI ${after?.last_error || 'không rõ'}`}, ${when}`);
  }
}

/** Các acc tới lượt (đã tới giờ hẹn, không bị giới hạn, chưa xếp hàng / đang chạy), lâu nhất trước */
function dueList(now = Date.now()) {
  return db.prepare(`SELECT id, proxy FROM accounts
    WHERE paused = 0 AND (next_sync_at IS NULL OR next_sync_at <= ?) AND (backoff_until IS NULL OR backoff_until <= ?)
    ORDER BY COALESCE(next_sync_at, 0), id`).all(now, now)
    .filter(a => (a.proxy || directPauseUntil <= now) && !pending.has(a.id) && !busyAccounts.has(a.id));
}
export const pickDue = (now = Date.now()) => dueList(now)[0] || null;

const stillDue = id => !!db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND paused = 0
  AND (next_sync_at IS NULL OR next_sync_at <= ?) AND (backoff_until IS NULL OR backoff_until <= ?)`).get(id, Date.now(), Date.now());

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
  // Gọi riêng (thêm acc, bấm đồng bộ…): giữ chỗ trước để lịch tự động không lấy trùng acc này.
  // syncOne sẽ ghi lại giờ hẹn thật khi xong.
  if (ids) {
    const hold = db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?');
    for (const id of ids) {
      hold.run(Date.now() + nextDelayMs(s), id);
      progress.set(id, { state: 'queued', percent: 0, step: 'Đang chờ tới lượt', queued_at: Date.now() });
    }
  }
  // Các acc chạy song song theo luật ở withLock (mỗi proxy 1 acc, tối đa max_parallel)
  await Promise.all(list.map(async id => {
    const acc = db.prepare('SELECT proxy FROM accounts WHERE id = ?').get(id);
    if (!ids && acc && !acc.proxy && directPauseUntil > Date.now()) return;
    pending.add(id);
    try { await withLock(() => syncOne(id, s), id); } finally { pending.delete(id); }
  }));
  await flushAlerts(s);
  return true;
}

/** Acc lâu không lấy được dữ liệu mới: node chuyển sang "Chưa rõ" thay vì giữ màu xanh cũ.
 *  Lần lấy dữ liệu thành công kế tiếp sẽ tính lại trạng thái thật. */
export function markStale(now = Date.now(), s = getSettings()) {
  return db.prepare(`UPDATE devices SET status = 'unknown', online = 0, status_changed_at = ?
    WHERE missing = 0 AND status NOT IN ('unknown', 'banned')
      AND account_id IN (SELECT id FROM accounts WHERE archived_at IS NULL AND COALESCE(last_ok_at, 0) < ?)`).run(now, now - staleMs(s)).changes;
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
  markStale();
  const loop = () => {
    const s = getSettings();
    try {
      // Chạy các acc tới lượt khi còn chỗ; acc nào đường ra đang bận / đang nghỉ thì để lần sau
      for (const due of dueList()) {
        if (active >= maxParallel(s)) break;
        const route = routeOf(due.proxy);
        if (!take(due.id, route)) continue;
        runTaken(due.id, route, () => stillDue(due.id) ? syncOne(due.id, s) : null).catch(e => console.error('scheduler', e));
      }
      syncState.nextCycleAt = db.prepare('SELECT MIN(next_sync_at) AS t FROM accounts WHERE paused = 0').get().t;
    } catch (e) {
      console.error('scheduler', e);
    }
    // Xét lại mỗi giây để kịp thấy acc mới / acc xong / cài đặt mới
    setTimeout(loop, 1000);
  };
  setTimeout(loop, 2000);
  // Gom cảnh báo gửi Telegram mỗi phút, tránh spam từng tin
  setInterval(() => {
    const s = getSettings();
    markStale(Date.now(), s);
    flushAlerts(s);
    dailyReport(s).catch(e => console.error('daily report', e.message));
    cleanup(s);
  }, 60e3);
}

/** Tiến độ các acc cho giao diện: %, việc đang làm, ước tính còn bao lâu (giây) */
export function getProgress(ids, now = Date.now(), s = getSettings()) {
  for (const [id, p] of progress) if (p.finished_at && now - p.finished_at > 10 * 60e3) progress.delete(id);
  const delay = (Number(s.account_delay_sec) || 0) * 1000;
  const running = [...progress.values()].filter(p => p.state === 'running');
  // Acc đang chạy sớm xong nhất -> lúc có chỗ trống đầu tiên
  const runLeft = running.length >= maxParallel(s) ? Math.min(...running.map(p => Math.max(avgSyncMs - (now - p.started_at), 2000))) : 0;
  const queue = [...progress.entries()].filter(([, p]) => p.state === 'queued').sort((a, b) => a[1].queued_at - b[1].queued_at).map(([id]) => id);
  const accs = db.prepare(`SELECT id, last_sync_at, last_ok_at, last_error, balance,
    (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0) AS devices FROM accounts a WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids);
  return accs.map(a => {
    // Không có trong bộ nhớ (vd. web vừa khởi động lại): suy ra từ database
    const p = progress.get(a.id) || (a.last_ok_at ? { state: 'done', percent: 100, step: 'Đã tải xong' }
      : a.last_sync_at ? { state: 'error', step: 'Lấy dữ liệu lỗi', error: a.last_error }
      : { state: 'queued', percent: 0, step: 'Đang chờ tới lượt' });
    let eta = null;
    if (p.state === 'running') {
      const spent = now - p.started_at;
      // Đủ dữ liệu thì ước theo tốc độ thật của acc này, chưa đủ thì theo trung bình
      eta = p.percent >= 15 ? spent * (100 - p.percent) / p.percent : Math.max(avgSyncMs - spent, 2000);
    } else if (p.state === 'queued') {
      const pos = queue.indexOf(a.id);
      // Chạy song song max_parallel acc: cứ max_parallel acc phía trước thì thêm 1 lượt chờ
      eta = runLeft + delay + Math.floor(Math.max(pos, 0) / maxParallel(s)) * (avgSyncMs + delay) + avgSyncMs;
      p.ahead = Math.max(pos, 0) + running.length;
    }
    return { id: a.id, ...p, eta_sec: eta == null ? null : Math.round(eta / 1000), devices: a.devices, balance: a.balance };
  });
}
