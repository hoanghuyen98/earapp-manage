import { ProxyAgent, Socks5ProxyAgent } from 'undici';

const BASE = 'https://earnapp.com/dashboard/api/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const KEEP = ['oauth-refresh-token', 'oauth-token', 'auth', 'auth-method', 'xsrf-token'];

export class AuthError extends Error {}
export class BannedError extends Error {}
/** Không kết nối được (mạng, proxy chết…) */
export class NetworkError extends Error {}
/** EarnApp/Cloudflare chặn vì gọi quá nhiều. retryAfter: số giây server yêu cầu chờ (nếu có) */
export class RateLimitError extends Error {
  constructor(message, retryAfter = 0) { super(message); this.retryAfter = retryAfter; }
}

/**
 * Chuẩn hoá cookie người dùng dán vào: chấp nhận cả chuỗi cookie đầy đủ
 * từ trình duyệt hoặc chỉ giá trị oauth-refresh-token.
 * Chỉ giữ các cookie cần cho đăng nhập.
 */
export function normalizeCookie(input) {
  const raw = String(input || '').trim().replace(/^cookie:\s*/i, '');
  if (!raw) throw new Error('Cookie trống');
  if (!raw.includes('=')) {
    // Chỉ dán refresh token
    return `oauth-refresh-token=${raw}; auth=1; auth-method=google`;
  }
  const parts = Object.fromEntries(raw.split(/;\s*/).filter(p => p.includes('='))
    .map(p => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]));
  if (!parts['oauth-refresh-token']) throw new Error('Không tìm thấy oauth-refresh-token trong cookie');
  parts.auth ??= '1';
  parts['auth-method'] ??= 'google';
  return KEEP.filter(k => parts[k]).map(k => `${k}=${parts[k]}`).join('; ');
}

/** Proxy hợp lệ: http(s)://… hoặc socks5://… (có thể kèm user:pass@). Trả về chuỗi đã chuẩn hoá, sai thì báo lỗi. */
export function normalizeProxy(input) {
  let raw = String(input || '').trim();
  if (!raw) return '';
  // Kiểu nhà bán proxy hay đưa: host:port:user:pass (có thể kèm socks5:// phía trước)
  const m = raw.match(/^((?:[a-z0-9]+:\/\/)?)([^:/@\s]+):(\d+):([^:\s]+):(\S+)$/i);
  if (m) raw = `${m[1] || 'http://'}${encodeURIComponent(m[4])}:${encodeURIComponent(m[5])}@${m[2]}:${m[3]}`;
  let url;
  try { url = new URL(/^[a-z0-9]+:\/\//i.test(raw) ? raw : 'http://' + raw); } catch { throw new Error('Proxy không đúng định dạng'); }
  // socks5h / socks: undici dùng chung một kiểu SOCKS5
  if (/^socks(5h?)?:$/.test(url.protocol)) url.protocol = 'socks5:';
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) throw new Error('Proxy chỉ hỗ trợ http://, https:// hoặc socks5://');
  if (!url.hostname) throw new Error('Proxy thiếu địa chỉ (VD: socks5://user:pass@1.2.3.4:1080)');
  return url.href.replace(/\/$/, '');
}

const agents = new Map();
function dispatcherFor(proxy) {
  if (!proxy) return undefined;
  if (!agents.has(proxy)) {
    const url = normalizeProxy(proxy);
    agents.set(proxy, url.startsWith('socks5:') ? new Socks5ProxyAgent(url) : new ProxyAgent(url));
  }
  return agents.get(proxy);
}

const NET_ERRORS = {
  ECONNREFUSED: 'bị từ chối kết nối, proxy có thể đã chết',
  ECONNRESET: 'kết nối bị ngắt giữa chừng',
  ENOTFOUND: 'không tìm thấy địa chỉ',
  EAI_AGAIN: 'lỗi phân giải tên miền',
  EHOSTUNREACH: 'không tới được máy chủ',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class EarnAppClient {
  constructor(cookie, proxy = '') {
    this.cookie = cookie;
    this.dispatcher = dispatcherFor(proxy);
  }

  async call(name, { method = 'GET', body } = {}) {
    const url = BASE + name + (name.includes('?') ? '&' : '?') + 'appid=earnapp';
    const headers = {
      cookie: this.cookie,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'en-US,en;q=0.9',
      'x-requested-with': 'XMLHttpRequest',
      'user-agent': UA,
      referer: 'https://earnapp.com/dashboard/me/passive-income',
    };
    const xsrf = this.cookie.match(/xsrf-token=([^;]+)/);
    if (xsrf) headers['xsrf-token'] = xsrf[1];
    if (body) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        dispatcher: this.dispatcher, signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      // "fetch failed" không nói lên gì: lấy lý do thật (proxy chết, sai mật khẩu proxy, hết thời gian…)
      const code = e.cause?.code || '';
      const why = e.name === 'TimeoutError' || /TIMEOUT/.test(code) ? 'quá thời gian không phản hồi'
        : NET_ERRORS[code] ? `${NET_ERRORS[code]} (${code})`
        : e.cause?.message || e.message;
      throw new NetworkError(`Không kết nối được EarnApp${this.dispatcher ? ' qua proxy' : ''}: ${why}`);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (res.ok) return data;
    const blockedPage = typeof data === 'string' && /cloudflare|just a moment|attention required|rate limit/i.test(data);
    if (res.status === 429 || res.status === 503 || (res.status === 403 && blockedPage)) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw new RateLimitError(`EarnApp giới hạn truy cập (HTTP ${res.status})`, retryAfter);
    }
    const msg = typeof data === 'object' ? (data.error || JSON.stringify(data)) : String(data).slice(0, 200);
    if (/auth required|unauthori[sz]ed|not logged/i.test(msg) || res.status === 401) throw new AuthError(msg);
    // Chỉ tin lỗi JSON của EarnApp; trang chặn của Cloudflare (HTML) không phải là ban
    if (typeof data === 'object' && /\bban|suspend|fraud|terminated/i.test(msg)) throw new BannedError(msg);
    throw new Error(`EarnApp ${name} lỗi ${res.status}: ${msg}`);
  }

  /** Lấy toàn bộ dữ liệu cần thiết của 1 tài khoản */
  async fetchAll({ withMonthly = false, onStep = () => {} } = {}) {
    const gap = () => sleep(300 + Math.random() * 500);
    // Báo tiến độ cho giao diện: onStep(phần đã xong 0..1, việc đang làm)
    const total = withMonthly ? 7 : 6;
    let done = 0;
    const step = (label, part = 1) => { done += part; onStep(Math.min(done / total, 1), label); };
    onStep(0, 'Đang lấy thông tin tài khoản');
    const user = await this.call('user_data'); step('Đang lấy số dư'); await gap();
    const money = await this.call('money'); step('Đang lấy danh sách node'); await gap();
    const devices = await this.call('devices'); step(`Đang lấy trạng thái ${devices.length} node`); await gap();
    const fetchStatuses = async () => {
      const out = {};
      for (let i = 0; i < devices.length; i += 100) {
        const chunk = devices.slice(i, i + 100).map(d => ({ uuid: d.uuid }));
        Object.assign(out, await this.call('device_statuses', { method: 'POST', body: { devices: chunk } }));
        await gap();
      }
      return out;
    };
    let statuses = await fetchStatuses();
    // EarnApp đôi khi trả rỗng thoáng qua: thử lại 1 lần sau 3 giây
    if (devices.length && !Object.keys(statuses).length) {
      await sleep(3000);
      statuses = await fetchStatuses();
    }
    step('Đang lấy lịch sử rút tiền');
    const transactions = await this.call('transactions'); step('Đang lấy dung lượng'); await gap();
    // Dung lượng không bắt buộc: lỗi thì bỏ qua, không làm hỏng cả lần đồng bộ
    let usage = null;
    try { usage = await this.call('usage?step=daily'); } catch (e) { if (e instanceof AuthError || e instanceof RateLimitError) throw e; }
    let usageMonthly = null;
    if (withMonthly) {
      step('Đang lấy dung lượng theo tháng');
      await gap();
      try { usageMonthly = await this.call('usage?step=monthly'); } catch (e) { if (e instanceof AuthError || e instanceof RateLimitError) throw e; }
    }
    step('Đang lưu dữ liệu', total);
    return { user, money, devices, statuses, transactions, usage, usageMonthly };
  }
}
