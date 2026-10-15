import { db } from './db.js';
import { esc } from './telegram.js';
import { localDate, summary, staleMs } from './stats.js';

const NAMES_MAX = 3; // mỗi loại vấn đề ghi tối đa 3 tên acc, còn lại "+N"

/** Tên ngắn: tên riêng, không có thì phần trước @ của email */
const shortName = a => a.label || String(a.email || `#${a.id}`).split('@')[0];

/** Báo cáo cuối ngày gửi Telegram: gọn, độ dài cố định dù có bao nhiêu acc. Chi tiết xem trên web */
export function formatDailyReport(s, now = Date.now()) {
  const tz = s.timezone || 'Asia/Ho_Chi_Minh';
  const t = summary();
  const today = localDate(now, tz);
  const usd = n => '$' + (Number(n) || 0).toFixed(2);
  const vnd = n => Math.round((Number(n) || 0) * (s.usd_vnd || 0)).toLocaleString('vi-VN') + 'đ';
  const hhmm = ts => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
  const nonZero = items => items.filter(([n]) => n > 0).map(([n, e, l]) => `${e}${n} ${l}`).join(' · ');

  const accs = db.prepare(`SELECT a.id, a.email, a.label, a.status, a.paused, a.auth_state, a.last_ok_at, a.suspect_reason, a.balance,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status IN ('online', 'idle')) AS running,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0) AS total
    FROM accounts a WHERE a.archived_at IS NULL`).all();
  const staleCut = now - staleMs(s);
  const isStale = a => !a.paused && a.status !== 'banned' && (a.last_ok_at || 0) < staleCut;

  const [, mo, dd] = today.split('-');
  const lines = [`📊 <b>Báo cáo ${dd}/${mo}</b> · ${hhmm(now)}`, ''];

  lines.push(`💵 Hôm nay: <b>${usd(t.today)}</b>${s.usd_vnd ? ` (${vnd(t.today)})` : ''} · hôm qua ${usd(t.yesterday)}`);
  lines.push(`💰 Số dư: <b>${usd(t.current)}</b>${t.pending_count ? ` · chờ về ví ${usd(t.pending)}` : ''}`);

  const dv = t.devices;
  const devTotal = dv.online + dv.idle + dv.offline + dv.banned + dv.unknown;
  lines.push(`🖥 ${devTotal} node: ${nonZero([[dv.online, '🟢', 'chạy'], [dv.idle, '🟡', 'không tăng tiền'], [dv.offline, '⚫', 'rớt'], [dv.banned, '🔺', 'ban'], [dv.unknown, '❔', 'chưa rõ']]) || '—'}`);

  // Vấn đề cấp acc, gộp theo loại (mỗi acc chỉ tính vấn đề nặng nhất), kèm việc cần làm
  const groups = [
    ['⛔', 'bị EarnApp khoá', list => `tiền kẹt ${usd(list.reduce((n, a) => n + (a.balance || 0), 0))}, không lấy lại được`, a => a.status === 'banned'],
    ['🔑', 'cookie hết hạn', () => 'dán cookie mới trên web', a => a.auth_state === 'expired'],
    ['❔', 'không lấy được dữ liệu', () => 'kiểm tra proxy', isStale],
    ['❓', 'nghi bị khoá', () => 'kiểm tra trên EarnApp', a => !!a.suspect_reason],
    ['⚫', 'không node nào chạy', () => 'bật lại máy / app EarnApp', a => a.total > 0 && a.running === 0],
  ];
  const taken = new Set();
  const issues = [];
  for (const [icon, label, todo, test] of groups) {
    const list = accs.filter(a => !taken.has(a.id) && test(a));
    list.forEach(a => taken.add(a.id));
    if (!list.length) continue;
    const names = list.slice(0, NAMES_MAX).map(a => esc(shortName(a))).join(', ') + (list.length > NAMES_MAX ? ` +${list.length - NAMES_MAX}` : '');
    issues.push(`${icon} ${list.length} ${label} → ${todo(list)}: ${names}`);
  }
  lines.push(`👤 ${accs.length} acc${issues.length ? `, <b>${taken.size} acc có vấn đề:</b>` : ' · ✅ không có vấn đề'}`);
  if (issues.length) lines.push(...issues);

  // Lịch rút sắp tới: 1 dòng
  const upcoming = db.prepare(`SELECT COUNT(*) AS n, MIN(next_run_at) AS first FROM withdraw_schedules WHERE enabled = 1 AND next_run_at BETWEEN ? AND ?`).get(now, now + 864e5);
  if (upcoming.n) lines.push(`📅 ${upcoming.n} acc rút theo lịch trong 24 giờ tới, sớm nhất ${hhmm(upcoming.first)}`);

  return lines.join('\n');
}
