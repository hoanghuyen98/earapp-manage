import { db } from './db.js';
import { esc } from './telegram.js';
import { localDate, summary, fmtBytes, staleMs } from './stats.js';

const TOP_MAX = 5;

/** Báo cáo tổng kết cuối ngày gửi Telegram */
export function formatDailyReport(s, now = Date.now()) {
  const tz = s.timezone || 'Asia/Ho_Chi_Minh';
  const t = summary();
  const today = localDate(now, tz);
  const usd = n => '$' + (Number(n) || 0).toFixed(2);
  const vnd = n => Math.round((Number(n) || 0) * (s.usd_vnd || 0)).toLocaleString('vi-VN') + 'đ';
  const money = n => s.usd_vnd ? `${usd(n)} (${vnd(n)})` : usd(n);
  const hhmm = ts => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ts);
  const ddmm = ts => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(ts);
  // [số, 'emoji', 'chữ'] -> "🟢 20 chạy · 🔴 3 rớt mạng", bỏ mục bằng 0
  const joinNonZero = items => items.filter(([n]) => n > 0).map(([n, e, l]) => `${e ? e + ' ' : ''}${n} ${l}`).join(' · ');

  const accs = db.prepare(`SELECT a.id, a.email, a.label, a.status, a.paused, a.auth_state, a.last_ok_at,
      COALESCE((SELECT last_total - first_total FROM account_daily d WHERE d.account_id = a.id AND d.date = ?), 0) AS today,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status = 'online') AS active,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.missing = 0 AND d.status != 'banned') AS total
    FROM accounts a WHERE a.archived_at IS NULL`).all(today);
  const staleCut = now - staleMs(s);
  const stale = accs.filter(a => !a.paused && (a.last_ok_at || 0) < staleCut);
  const name = a => esc(a.email || a.label || `Acc #${a.id}`);

  const [, mo, dd] = today.split('-');
  const out = [`📊 <b>Báo cáo ngày ${dd}/${mo}</b> · ${hhmm(now)}`];

  // Cảnh báo số liệu chưa đầy đủ lên đầu, tránh hiểu nhầm "hôm nay $0"
  if (stale.length) {
    const since = Math.min(...stale.map(a => a.last_ok_at || now));
    out.push(`⚠️ <b>${stale.length}/${accs.length} acc không lấy được dữ liệu</b> từ ${hhmm(since)} ${ddmm(since)}`
      + `\nSố liệu dưới đây chưa đầy đủ.`);
  }

  // Thu nhập
  const diff = t.today - t.yesterday;
  const trend = Math.abs(diff) < 0.0005 ? 'bằng hôm qua' : `${diff > 0 ? '⬆️ +' : '⬇️ -'}${usd(Math.abs(diff))} so với hôm qua`;
  out.push([
    `💵 <b>Thu nhập</b>`,
    `• Hôm nay: <b>${money(t.today)}</b>${stale.length ? ', thiếu dữ liệu' : `, ${trend} (${usd(t.yesterday)})`}`,
    ...(stale.length ? [`• Hôm qua: ${usd(t.yesterday)}`] : []),
    `• Tháng ${Number(mo)}: ${money(t.month)}`,
  ].join('\n'));

  // Máy & acc: chỉ ghi các mục khác 0
  const dv = t.devices;
  const devTotal = dv.online + dv.idle + dv.offline + dv.banned + dv.unknown;
  const ac = t.accounts;
  // Acc đang lỗi dữ liệu: trạng thái chạy/dừng là cũ, tính riêng là "chưa rõ"
  const fresh = accs.filter(a => !stale.includes(a));
  const accLine = joinNonZero([[fresh.filter(a => a.status === 'running').length, '🟢', 'chạy'], [fresh.filter(a => a.status === 'stopped').length, '🟠', 'dừng'],
    [accs.filter(a => a.status === 'banned').length, '⛔', 'bị khoá'], [stale.filter(a => a.status !== 'banned').length, '❔', 'chưa rõ']]);
  const expired = accs.filter(a => a.auth_state === 'expired').length;
  const accIssues = joinNonZero([[expired, '', 'acc cookie hết hạn'], [stale.filter(a => a.auth_state !== 'expired').length, '', 'acc không lấy được dữ liệu'], [ac.suspects, '', 'acc nghi bị khoá']]);
  out.push([
    `🖥 <b>Máy: ${devTotal}</b>`,
    `• ${joinNonZero([[dv.online, '🟢', 'chạy'], [dv.idle, '🟡', 'không ra tiền'], [dv.offline, '🔴', 'rớt mạng'], [dv.banned, '⚪', 'bị ban'], [dv.unknown, '❔', 'chưa rõ']]) || 'chưa có máy'}`,
    `👤 <b>Tài khoản: ${ac.total}</b>`,
    `• ${accLine || '—'}`,
    ...(accIssues ? [`• Cần xử lý: ${accIssues}`] : []),
  ].join('\n'));

  // Acc kiếm nhiều nhất hôm nay
  const top = accs.filter(a => a.today > 0).sort((x, y) => y.today - x.today);
  if (top.length) {
    out.push([`🏆 <b>Acc kiếm nhiều nhất hôm nay</b>`,
      ...top.slice(0, TOP_MAX).map(a => `• ${name(a)}: ${usd(a.today)} · ${a.active}/${a.total} máy chạy`),
      ...(top.length > TOP_MAX ? [`• … và ${top.length - TOP_MAX} acc khác`] : [])].join('\n'));
  }
  // Acc có máy mà cả ngày không ra đồng nào (không tính acc đang lỗi dữ liệu)
  const zero = accs.filter(a => a.total > 0 && a.today <= 0 && a.status !== 'banned' && !a.paused && (a.last_ok_at || 0) >= staleCut);
  if (zero.length && accs.length > 1) {
    out.push(`😴 <b>${zero.length} acc chưa kiếm được đồng nào hôm nay</b>\n` + zero.slice(0, TOP_MAX).map(a => `• ${name(a)}: ${a.active}/${a.total} máy chạy`).join('\n')
      + (zero.length > TOP_MAX ? `\n• … và ${zero.length - TOP_MAX} acc khác` : ''));
  }

  out.push([
    `💰 <b>Tiền</b>`,
    `• Số dư: <b>${money(t.current)}</b>`,
    `• Đã rút: ${usd(t.withdrawn)}${t.pending_count ? ` · đang chờ ${usd(t.pending)} (${t.pending_count} lệnh)` : ''}`,
    `• Tổng kiếm từ trước tới nay: ${usd(t.lifetime)}`,
    ...(t.banned > 0 ? [`• Mất do bị khoá: ${usd(t.banned)}`] : []),
  ].join('\n'));

  // Lịch rút trong 24 giờ tới
  const upcoming = db.prepare(`SELECT w.next_run_at, w.method, a.email, a.balance FROM withdraw_schedules w JOIN accounts a ON a.id = w.account_id
    WHERE w.enabled = 1 AND w.next_run_at BETWEEN ? AND ? ORDER BY w.next_run_at`).all(now, now + 864e5);
  if (upcoming.length) {
    out.push(`📅 <b>Rút theo lịch trong 24 giờ tới: ${upcoming.length} acc</b>\n`
      + upcoming.slice(0, TOP_MAX).map(w => `• ${hhmm(w.next_run_at)} ${ddmm(w.next_run_at)}: ${esc(w.email)} (số dư ${usd(w.balance)})`).join('\n')
      + (upcoming.length > TOP_MAX ? `\n• … và ${upcoming.length - TOP_MAX} acc khác` : ''));
  }

  out.push(`📶 Dung lượng: hôm nay ${fmtBytes(t.usage_today)} · 7 ngày ${fmtBytes(t.usage_7d)}`);
  return out.join('\n\n');
}

