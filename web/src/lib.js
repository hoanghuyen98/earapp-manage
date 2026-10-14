// Gọi API + các hàm định dạng dùng chung

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    window.dispatchEvent(new Event('auth:logout'));
  }
  if (!res.ok) throw new ApiError(data.error || `Lỗi ${res.status}`, res.status);
  return data;
}

export const usd = (n, digits = 2) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const vnd = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN') + 'đ';

export const vndShort = (n) => {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace('.0', '').replace('.', ',') + ' tỷ';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace('.0', '').replace('.', ',') + ' tr';
  if (a >= 1e4) return Math.round(v / 1e3) + 'k';
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace('.0', '').replace('.', ',') + 'k';
  return Math.round(v) + 'đ';
};

/** Byte -> MB/GB, hệ 1000 giống EarnApp */
export function fmtBytes(n, compact = false) {
  const v = Number(n) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(2) + ' TB';
  if (v >= 1e9) return (v / 1e9).toFixed(compact ? 1 : 2) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(compact && v >= 1e8 ? 0 : 1) + ' MB';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + ' KB';
  return v ? v + ' B' : '0 MB';
}

export function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

export function timeUntil(ts) {
  if (!ts) return '—';
  const s = (ts - Date.now()) / 1000;
  if (s <= 30) return 'sắp tới';
  if (s < 3600) return `khoảng ${Math.ceil(s / 60)} phút nữa`;
  return `khoảng ${Math.round(s / 3600)} giờ nữa`;
}

export function duration(ms) {
  if (!ms) return '0p';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}n ${h}g`;
  if (h) return `${h}g ${mm}p`;
  return `${mm}p`;
}

export const fmtDate = (v) => v ? new Date(v).toLocaleDateString('vi-VN') : '—';
export const fmtDateTime = (v) => v ? new Date(v).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const shortDate = (d) => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '';

export const DEVICE_STATUS = {
  online: { label: 'Đang chạy', color: 'bg-good', text: 'text-good', hint: 'Máy online và đang ra tiền' },
  idle: { label: 'Không ra tiền', color: 'bg-warn', text: 'text-amber-600 dark:text-warn', hint: 'Online nhưng nhiều giờ không tăng tiền' },
  offline: { label: 'Rớt mạng', color: 'bg-bad', text: 'text-bad', hint: 'Máy bị tắt hoặc mất kết nối' },
  banned: { label: 'Bị ban', color: 'bg-muted', text: 'text-zinc-500', hint: 'EarnApp đã chặn máy này' },
  unknown: { label: 'Chưa rõ', color: 'bg-zinc-300 dark:bg-zinc-600', text: 'text-zinc-400', hint: 'Web không lấy được dữ liệu mới từ EarnApp, chưa biết máy đang chạy hay không' },
};

/** Lỗi kỹ thuật -> câu dễ hiểu (giống tin Telegram) */
export function explainError(msg = '') {
  const m = String(msg || '');
  if (/lỗi 404|Not found/i.test(m)) return 'EarnApp trả lỗi 404 (không tìm thấy). Thường do EarnApp đang bảo trì hoặc chặn IP của web.';
  if (/lỗi 5\d\d/.test(m)) return 'Máy chủ EarnApp đang lỗi.';
  return m;
}

export const ACCOUNT_STATUS = {
  running: { label: 'Running', vi: 'Đang chạy', hint: 'Còn máy đang chạy (tự động)', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20' },
  stopped: { label: 'Stopped', vi: 'Đã dừng', hint: 'Không còn máy nào online (tự động)', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20' },
  banned: { label: 'Banned', vi: 'Bị khoá', hint: 'Tài khoản bị EarnApp khoá', cls: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20' },
};

export const TX_STATUS = {
  paid: { label: 'Đã nhận', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20' },
  pending_procedure: { label: 'Đang xử lý', cls: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-500/20' },
  approved: { label: 'Đã duyệt', cls: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-500/20' },
  pending: { label: 'Đang chờ', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20' },
};
export const txStatus = (s) => TX_STATUS[s] || { label: s || '—', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20' };

export const countryCode = (c) => (c || '').toUpperCase();
