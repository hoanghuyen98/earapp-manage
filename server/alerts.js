import { esc } from './telegram.js';

// Soạn tin Telegram từ danh sách cảnh báo: gom theo tài khoản, giải thích rõ và ghi việc cần làm

const BAN_REASON = { earnapp_blacklist: 'IP nằm trong danh sách đen', ip_quality: 'IP bị đánh giá chất lượng kém' };
const METHOD = { 'paypal.com': 'PayPal', 'amazon.com': 'Amazon Gift Card', wise: 'Wise' };

// Thứ tự hiển thị: việc nghiêm trọng / cần xử lý lên trước
const ORDER = ['account_banned', 'account_suspect', 'auth', 'sync_error', 'device_banned', 'device_offline', 'device_idle',
  'rate_limit', 'payout_paid', 'payout_new', 'sync_ok', 'device_online', 'device_unbanned'];

const LIST_MAX = 10;

function deviceLines(items, fmt = a => esc(a.device)) {
  const lines = items.slice(0, LIST_MAX).map(a => '   • ' + fmt(a));
  if (items.length > LIST_MAX) lines.push(`   … và ${items.length - LIST_MAX} máy khác`);
  return lines.join('\n');
}

export function formatAlerts(list, s) {
  const tz = s.timezone || 'Asia/Ho_Chi_Minh';
  const usd = n => '$' + (Number(n) || 0).toFixed(2);
  const vnd = n => Math.round((Number(n) || 0) * (s.usd_vnd || 0)).toLocaleString('vi-VN') + 'đ';
  const hhmm = ts => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ts);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(Date.now());
  const now = `${hhmm(Date.now())} ngày ${day}`;

  // Gom theo tài khoản, giữ thứ tự xuất hiện
  const byAcc = new Map();
  for (const a of list) {
    if (!byAcc.has(a.account_id)) byAcc.set(a.account_id, []);
    byAcc.get(a.account_id).push(a);
  }

  const blocks = [`🔔 <b>EarnApp Manager</b> · ${list.length} thông báo · ${now}`];
  for (const items of byAcc.values()) {
    const { label, email } = items[0];
    const head = label && email && label !== email
      ? `👤 <b>Tài khoản: ${esc(label)}</b>\n✉️ ${esc(email)}`
      : `👤 <b>Tài khoản: ${esc(email || label || '#' + items[0].account_id)}</b>`;
    const parts = [head];
    for (const type of ORDER) {
      const g = items.filter(a => a.type === type);
      if (!g.length) continue;
      const n = g.length;
      const first = g[0];
      switch (type) {
        case 'account_banned':
          parts.push(`⛔ <b>Tài khoản bị EarnApp KHOÁ</b>\nSố dư kẹt lại: <b>${usd(first.amount)}</b> (≈ ${vnd(first.amount)}). Web đã chuyển acc sang Banned và tính số tiền này vào mục "Mất do bị khoá".`);
          break;
        case 'account_suspect':
          parts.push(`❓ <b>Có dấu hiệu bị khoá</b>: ${esc(first.why)}.\nWeb đang giữ số dư cũ ${usd(first.amount)}.\n👉 Vào EarnApp kiểm tra, rồi mở acc này trên web và bấm "Đúng, bị khoá" hoặc "Không phải".`);
          break;
        case 'auth':
          parts.push(`🔑 <b>Cookie hết hạn</b>: web không lấy được dữ liệu acc này nữa.\n👉 Đăng nhập lại EarnApp, lấy cookie mới rồi dán vào web: Tài khoản → Sửa → Cập nhật cookie.`);
          break;
        case 'sync_error':
          parts.push(`⚠️ <b>Không lấy được dữ liệu</b> (lỗi ${first.count} lần liên tiếp): ${esc(first.why)}
Số liệu trên web đang dừng ở lần cập nhật cuối.
👉 ${first.proxy ? 'Kiểm tra proxy của acc này còn sống không, hết hạn thì đổi proxy mới trong Tài khoản → Sửa.' : 'Kiểm tra mạng của server, hoặc vào EarnApp xem acc còn đăng nhập được không.'}`);
          break;
        case 'sync_ok':
          parts.push(`✅ <b>Lấy dữ liệu bình thường trở lại</b> sau ${first.count} lần lỗi.`);
          break;
        case 'device_banned':
          parts.push(`🚫 <b>${n} máy bị EarnApp BAN</b>, không kiếm tiền được nữa:\n${deviceLines(g, a => `${esc(a.device)} (${esc(BAN_REASON[a.reason] || a.reason)})`)}\n👉 Thường do IP bị đánh giá xấu. Nên đổi IP/proxy cho máy này.`);
          break;
        case 'device_offline':
          parts.push(`🔴 <b>${n} máy RỚT MẠNG</b> (offline hơn ${s.offline_grace_min} phút):\n${deviceLines(g, a => `${esc(a.device)}${a.last_seen ? `, thấy lần cuối ${hhmm(a.last_seen)}` : ''}`)}\n👉 Kiểm tra máy còn bật, còn mạng và app EarnApp còn chạy.`);
          break;
        case 'device_idle':
          parts.push(`🟡 <b>${n} máy online nhưng KHÔNG RA TIỀN</b> (${s.idle_hours} giờ liền không tăng tiền):\n${deviceLines(g)}\n👉 Thử khởi động lại app EarnApp hoặc đổi IP cho máy.`);
          break;
        case 'rate_limit':
          parts.push(`⏳ <b>EarnApp đang chặn truy cập</b> vì gọi quá nhiều. Web tự giãn thời gian chờ rồi thử lại.\n👉 Nếu kéo dài: tăng thời gian lấy dữ liệu trong Cài đặt hoặc đặt proxy cho acc.`);
          break;
        case 'payout_paid':
          for (const a of g) parts.push(`✅ <b>Tiền đã về</b>: ${usd(a.amount)} (≈ ${vnd(a.amount)}) qua ${esc(METHOD[a.method] || a.method || '—')}`);
          break;
        case 'payout_new':
          for (const a of g) parts.push(`💸 <b>Lệnh rút mới</b>: ${usd(a.amount)} qua ${esc(METHOD[a.method] || a.method || '—')}, đang chờ EarnApp xử lý.`);
          break;
        case 'device_online':
          parts.push(`🟢 <b>${n} máy ONLINE trở lại</b>, chạy bình thường:\n${deviceLines(g)}`);
          break;
        case 'device_unbanned':
          parts.push(`♻️ <b>${n} máy được EarnApp GỠ BAN</b>, kiếm tiền lại bình thường (không cần làm gì):\n${deviceLines(g)}`);
          break;
      }
    }
    blocks.push(parts.join('\n\n'));
  }
  return blocks.join('\n\n━━━━━━━━━━━━\n\n');
}
