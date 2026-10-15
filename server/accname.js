// Tên và thứ tự acc dùng chung cho API, xuất Excel và tin Telegram.
// Acc có thể có tên riêng (label, VD "A1") và máy (group_name: máy thật / VPS chạy nhiều acc, VD "VPS-01"); email luôn hiện kèm.
// Thiết bị EarnApp trong mỗi acc gọi là "node".

const coll = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
/** So sánh chuỗi kiểu tự nhiên: "A2" trước "A10" */
export const cmp = (x, y) => coll.compare(String(x ?? ''), String(y ?? ''));

/** Xếp acc: theo máy (chưa gán máy xuống cuối), rồi tên riêng (chưa đặt tên xuống cuối), rồi email */
export const byAccount = (a, b) => (!a.group_name - !b.group_name) || cmp(a.group_name, b.group_name)
  || (!a.label - !b.label) || cmp(a.label, b.label) || cmp(a.email, b.email);

/** "A1 (a@gmail.com)", không có tên riêng thì chỉ email */
export const fullName = a => a.label ? `${a.label} (${a.email})` : a.email || `Acc #${a.id ?? a.account_id}`;

/** Loại proxy + địa chỉ, KHÔNG kèm user/mật khẩu: "SOCKS5 1.2.3.4:1080" */
export function proxyInfo(proxy) {
  if (!proxy) return '';
  try {
    const u = new URL(proxy);
    return `${u.protocol.replace(':', '').toUpperCase()} ${u.hostname}:${u.port}`;
  } catch { return ''; }
}
