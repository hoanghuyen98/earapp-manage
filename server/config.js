import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Đọc .env đơn giản (không cần thư viện dotenv)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, i).trim();
    if (!(key in process.env)) process.env[key] = line.slice(i + 1).trim();
  }
}

/**
 * Khôi phục từ file sao lưu (xem backup.js): web nhận file, kiểm tra, để vào data/restore-pending/ rồi tự khởi động lại.
 * Lúc khởi động, TRƯỚC khi mở database và đọc khoá, đổi file ở đây. Dữ liệu cũ cất vào data/truoc-khoi-phuc-<giờ>/ để lấy lại được.
 */
export function applyPendingRestore(dir = DATA_DIR) {
  const pending = path.join(dir, 'restore-pending');
  if (!fs.existsSync(path.join(pending, 'earnapp.db'))) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const old = path.join(dir, `truoc-khoi-phuc-${stamp}`);
  fs.mkdirSync(old, { recursive: true });
  for (const f of ['earnapp.db', 'earnapp.db-wal', 'earnapp.db-shm', 'secret.key']) {
    if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(old, f));
  }
  for (const f of ['earnapp.db', 'secret.key']) {
    if (fs.existsSync(path.join(pending, f))) fs.renameSync(path.join(pending, f), path.join(dir, f));
  }
  // File sao lưu không có khoá (web cũ dùng SECRET_KEY trong .env): giữ khoá đang dùng
  if (!fs.existsSync(path.join(dir, 'secret.key')) && fs.existsSync(path.join(old, 'secret.key'))) fs.copyFileSync(path.join(old, 'secret.key'), path.join(dir, 'secret.key'));
  fs.rmSync(pending, { recursive: true, force: true });
  console.log(`Đã khôi phục dữ liệu từ file sao lưu. Dữ liệu trước đó cất ở ${old}`);
  return old;
}
applyPendingRestore();

// Khoá mã hoá cookie: lấy từ env, nếu không có thì tự sinh và lưu vào data/
function loadSecret() {
  if (process.env.SECRET_KEY) return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  secret: loadSecret(),
  // Mật khẩu admin lần đầu (đổi được trong Cài đặt)
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  // Email được phép nhận tiền khi rút tự động. Chỉ sửa được trong .env trên máy chủ, không sửa được từ web
  payoutEmails: [...new Set((process.env.PAYOUT_EMAILS || '').split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(Boolean))],
};
