import { esc } from './telegram.js';

// Soạn tin Telegram từ danh sách cảnh báo.
// Mỗi mục: 1 dòng tiêu đề in đậm, vài dòng "•" chi tiết, 1 dòng "👉" việc cần làm (nếu có).
// Gom theo tài khoản; lỗi giống nhau ở nhiều acc thì gộp thành 1 mục chung.

const BAN_REASON = {
  earnapp_blacklist: 'IP bị đưa vào danh sách đen', earnapp_ip_blacklist: 'IP bị đưa vào danh sách đen',
  earnapp_device_blacklist: 'máy bị chặn', ip_quality: 'IP chất lượng kém', fraud_score: 'IP bị đánh giá rủi ro cao',
  ip_type: 'loại IP không được chấp nhận', country: 'quốc gia không được hỗ trợ',
};
const METHOD = { 'paypal.com': 'PayPal', 'amazon.com': 'Amazon Gift Card', wise: 'Wise', 'wise.com': 'Wise' };
export const methodName = m => METHOD[m] || (/^amazon/.test(m || '') ? 'Amazon Gift Card' : m || '—');

/** Lỗi kỹ thuật -> câu dễ hiểu */
export function explainError(msg = '') {
  const m = String(msg);
  if (/lỗi 404|Not found/i.test(m)) return 'EarnApp trả lỗi 404 (không tìm thấy). Thường do EarnApp đang bảo trì hoặc chặn IP của web';
  if (/lỗi 5\d\d/.test(m)) return 'Máy chủ EarnApp đang lỗi';
  if (/qua proxy/i.test(m)) return 'Không kết nối được qua proxy: ' + m.replace(/^.*qua proxy:\s*/i, '');
  if (/Không kết nối được EarnApp/i.test(m)) return 'Không kết nối được EarnApp: ' + m.replace(/^.*EarnApp:\s*/i, '');
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}

// Thứ tự: việc nghiêm trọng / cần xử lý lên trước
const ORDER = ['redeem_details_changed', 'withdraw_changed', 'account_banned', 'account_suspect', 'withdraw_failed', 'auth', 'sync_error',
  'device_banned', 'device_offline', 'device_idle', 'rate_limit', 'withdraw_skipped', 'withdraw_ok', 'payout_new', 'payout_paid',
  'sync_ok', 'device_online', 'device_unbanned'];

// Các loại gộp chung khi nhiều acc cùng gặp (cùng nội dung)
const MERGE = ['sync_error', 'sync_ok', 'auth', 'rate_limit'];
const MERGE_MIN = 3;
const LIST_MAX = 10;

function list(items, fmt) {
  const lines = items.slice(0, LIST_MAX).map(a => '• ' + fmt(a));
  if (items.length > LIST_MAX) lines.push(`• … và ${items.length - LIST_MAX} mục khác`);
  return lines.join('\n');
}

export function formatAlerts(alerts, s) {
  const tz = s.timezone || 'Asia/Ho_Chi_Minh';
  const usd = n => '$' + (Number(n) || 0).toFixed(2);
  const vnd = n => Math.round((Number(n) || 0) * (s.usd_vnd || 0)).toLocaleString('vi-VN') + 'đ';
  const money = n => s.usd_vnd ? `${usd(n)} (≈ ${vnd(n)})` : usd(n);
  const hhmm = ts => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ts);
  const ddmm = ts => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(ts);
  const when = ts => ddmm(ts) === ddmm(Date.now()) ? hhmm(ts) : `${hhmm(ts)} ${ddmm(ts)}`;
  const accName = a => a.email || a.label || `Acc #${a.account_id}`;

  // Một mục cho 1 nhóm cảnh báo cùng loại (g) của 1 acc, hoặc gộp nhiều acc (merged = true)
  function item(type, g, merged = false) {
    const n = g.length, a = g[0];
    // Tiêu đề: 1 acc -> "Cookie hết hạn"; gộp nhiều acc -> "3 acc cookie hết hạn" kèm danh sách acc
    const head = text => merged ? `${n} acc ${text[0].toLowerCase()}${text.slice(1)}` : text;
    const accList = () => merged ? '\n' + list(g, x => esc(accName(x))).replace(/^• /gm, '▫️ ') : '';
    switch (type) {
      case 'redeem_details_changed': {
        const fmt = d => d ? `${esc(methodName(d.payment_method))} → ${esc(d.email)}` : 'chưa cài';
        if (!a.new) return `ℹ️ <b>Auto-redeem trên EarnApp đã tắt</b>\n• Trước đó: ${fmt(a.old)}`;
        return `🚨 <b>Email nhận tiền trên EarnApp bị đổi</b>\n• Cũ: ${fmt(a.old)}\n• Mới: <b>${fmt(a.new)}</b>`
          + (a.foreign ? '\n• ⚠️ Email mới KHÔNG phải email của acc / danh sách cho phép' : '')
          + '\n• EarnApp sẽ tự rút hết số dư tới email mới lúc 13:00 mỗi ngày'
          + '\n👉 Không phải bạn đổi: vào EarnApp → Cashout → Auto-redeem → Disable ngay, rồi đổi mật khẩu Google';
      }
      case 'withdraw_changed':
        return `🛡 <b>Lịch rút tiền vừa thay đổi</b>\n${list(g, x => `${esc(x.why)} (IP ${esc(x.ip)})`)}\n👉 Không phải bạn làm: đổi mật khẩu web ngay`;
      case 'account_banned':
        return `⛔ <b>Acc bị EarnApp KHOÁ</b>\n• Số dư kẹt: <b>${money(a.amount)}</b>\n• Đã tính vào mục "Mất do bị khoá"`;
      case 'account_suspect':
        return `❓ <b>Nghi acc bị khoá</b>\n• Dấu hiệu: ${esc(a.why)}\n• Web đang giữ số dư cũ ${usd(a.amount)}\n👉 Kiểm tra trên EarnApp, rồi mở acc trên web bấm "Đúng, bị khoá" hoặc "Không phải"`;
      case 'withdraw_failed':
        return `❌ <b>Rút tiền THẤT BẠI</b>\n• Lý do: ${esc(a.why)}\n👉 Vào web: Rút tiền → Hẹn giờ rút để kiểm tra`;
      case 'withdraw_skipped':
        return `⏭ <b>Bỏ qua lần rút theo lịch</b>\n• ${esc(a.why)}\n• Lịch hằng tuần vẫn giữ, lần sau rút tiếp`;
      case 'withdraw_ok':
        return `💰 <b>Đã gửi lệnh rút ${usd(a.amount)}</b>\n• Qua ${esc(methodName(a.method))} → ${esc(a.to)}\n• Chờ EarnApp duyệt và chuyển tiền`;
      case 'auth':
        return `🔑 <b>${head('Cookie hết hạn')}</b>, web không lấy được dữ liệu` + accList()
          + '\n👉 Đăng nhập lại EarnApp, lấy cookie mới, dán vào web: Tài khoản → Sửa → Cập nhật cookie';
      case 'sync_error': {
        const since = Math.min(...g.map(x => x.since || Infinity));
        return `⚠️ <b>${head('Không lấy được dữ liệu mới')}</b>` + accList()
          + `\n• Lỗi: ${esc(explainError(a.why))}`
          + (Number.isFinite(since) ? `\n• Số liệu trên web đang dừng từ ${when(since)}, máy sẽ hiện "Chưa rõ"` : '\n• Số liệu trên web đang dừng ở lần cập nhật cuối')
          + `\n👉 ${a.proxy ? 'Kiểm tra proxy của acc còn sống không, hết hạn thì đổi proxy mới' : 'Mở thử earnapp.com/dashboard trên trình duyệt: không vào được thì chờ EarnApp hoạt động lại'}`;
      }
      case 'sync_ok':
        return `✅ <b>${head('Lấy dữ liệu bình thường trở lại')}</b>` + accList();
      case 'rate_limit':
        return `⏳ <b>${head('Bị EarnApp giới hạn truy cập')}</b> (gọi quá nhiều)` + accList()
          + '\n• Web tự giãn thời gian chờ rồi thử lại\n👉 Kéo dài thì tăng thời gian lấy dữ liệu trong Cài đặt hoặc gắn proxy cho acc';
      case 'device_banned':
        return `🚫 <b>${n} máy bị BAN</b>, không kiếm tiền được\n${list(g, x => `${esc(x.device)}: ${esc(BAN_REASON[x.reason] || x.reason)}`)}\n👉 Đổi IP / proxy cho máy`;
      case 'device_offline':
        return `🔴 <b>${n} máy RỚT MẠNG</b> (quá ${s.offline_grace_min} phút)\n${list(g, x => `${esc(x.device)}${x.last_seen ? `, online lần cuối ${when(x.last_seen)}` : ''}`)}\n👉 Kiểm tra máy còn bật, còn mạng, app EarnApp còn chạy`;
      case 'device_idle':
        return `🟡 <b>${n} máy online nhưng KHÔNG RA TIỀN</b> (${s.idle_hours} giờ không tăng)\n${list(g, x => esc(x.device))}\n👉 Khởi động lại app EarnApp hoặc đổi IP`;
      case 'payout_new':
        return g.map(x => `💸 <b>Lệnh rút mới ${usd(x.amount)}</b>\n• Qua ${esc(methodName(x.method))}, đang chờ EarnApp xử lý`).join('\n\n');
      case 'payout_paid':
        return g.map(x => `✅ <b>Tiền đã về: ${money(x.amount)}</b>\n• Qua ${esc(methodName(x.method))}`).join('\n\n');
      case 'device_online':
        return `🟢 <b>${n} máy chạy lại</b>\n${list(g, x => esc(x.device))}`;
      case 'device_unbanned':
        return `♻️ <b>${n} máy được gỡ ban</b>, kiếm tiền lại bình thường\n${list(g, x => esc(x.device))}`;
    }
    return null;
  }

  // Gộp lỗi giống nhau ở nhiều acc
  const merged = [];
  let rest = alerts;
  for (const type of MERGE) {
    const byWhy = new Map();
    for (const a of rest.filter(x => x.type === type)) {
      const k = type === 'sync_error' ? explainError(a.why) : '';
      if (!byWhy.has(k)) byWhy.set(k, []);
      byWhy.get(k).push(a);
    }
    for (const g of byWhy.values()) {
      if (g.length < MERGE_MIN) continue;
      merged.push({ type, g });
      rest = rest.filter(x => !g.includes(x));
    }
  }

  const byAcc = new Map();
  for (const a of rest) {
    if (!byAcc.has(a.account_id)) byAcc.set(a.account_id, []);
    byAcc.get(a.account_id).push(a);
  }

  // Cảnh báo bị giữ lại do gửi lỗi trước đó: ghi rõ là gửi trễ
  const oldest = Math.min(...alerts.map(a => a.ts || Date.now()));
  const late = Date.now() - oldest > 5 * 60e3 ? `\n⏱ Gửi trễ do lỗi kết nối Telegram, có tin từ ${when(oldest)}` : '';
  const blocks = [`🔔 <b>EarnApp</b> · ${hhmm(Date.now())} ${ddmm(Date.now())} · ${alerts.length} thông báo${late}`];
  for (const type of ORDER) for (const m of merged.filter(x => x.type === type)) blocks.push(item(type, m.g, true));
  for (const items of byAcc.values()) {
    const parts = [`👤 <b>${esc(accName(items[0]))}</b>`];
    for (const type of ORDER) {
      const g = items.filter(a => a.type === type);
      if (g.length) parts.push(item(type, g));
    }
    blocks.push(parts.filter(Boolean).join('\n\n'));
  }
  return blocks[0] + '\n\n' + blocks.slice(1).join('\n\n— — —\n\n');
}
