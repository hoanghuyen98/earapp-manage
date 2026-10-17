import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM cho cookie EarnApp lưu trong DB
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.secret, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

export const decrypt = payload => decryptWith(config.secret, payload);

/** Giải mã bằng khoá chỉ định (kiểm tra file sao lưu của web khác có đọc được không). Sai khoá thì báo lỗi */
export function decryptWith(key, payload) {
  const [iv, tag, enc] = payload.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// Token phiên đăng nhập web: user.ver.expires.hmac. ver khớp users.session_ver mới hợp lệ (đổi mật khẩu thì tăng ver)
export function signSession(user, ver = 0, ttlMs = 30 * 864e5) {
  const body = `${user}.${ver}.${Date.now() + ttlMs}`;
  const mac = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySession(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  const parts = body.split('.');
  if (parts.length < 3) return null; // token kiểu cũ
  const exp = Number(parts.pop()), ver = Number(parts.pop()), user = parts.join('.');
  return exp > Date.now() ? { user, ver } : null;
}
