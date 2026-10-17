import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';
import { db, getSettings, addEvent, tx } from './db.js';
import { encrypt, decrypt, decryptWith } from './crypto.js';
import { zip, unzip } from './zip.js';
import { createMachine, resolveMachine, MachineError } from './machines.js';
import { normalizeProxy } from './earnapp.js';
import { startImportJob } from './addJobs.js';

// Hai cách mang dữ liệu sang VPS khác:
// 1. Sao lưu / khôi phục TOÀN BỘ: database + khoá giải mã cookie (lịch sử, báo cáo, cài đặt, lịch rút…), thay hẳn dữ liệu web mới.
// 2. Xuất / nhập DANH SÁCH ACC: máy + acc + cookie + proxy, khoá bằng mật khẩu riêng. Nhập vào web đang chạy (gộp, không xoá gì),
//    acc vào thẳng không phải kiểm tra lại từng cookie, rồi tải dữ liệu song song ở nền.

const UPLOAD = path.join(DATA_DIR, 'restore-upload');
const PENDING = path.join(DATA_DIR, 'restore-pending');
const stamp = () => new Intl.DateTimeFormat('sv-SE', { timeZone: getSettings().timezone, dateStyle: 'short', timeStyle: 'short' })
  .format(Date.now()).replace(/[: ]/g, '-');

// ================== 1. Sao lưu / khôi phục toàn bộ ==================

/** File zip: database (bản sao nhất quán) + khoá + hướng dẫn. Trả về { name, data } */
export function makeBackup() {
  const tmp = path.join(os.tmpdir(), `eam-backup-${Date.now()}-${process.pid}.db`);
  try {
    // VACUUM INTO tạo bản sao nhất quán kể cả khi web đang ghi dữ liệu
    db.prepare('VACUUM INTO ?').run(tmp);
    const files = [{ name: 'earnapp.db', data: fs.readFileSync(tmp) }];
    const keyFile = path.join(DATA_DIR, 'secret.key');
    if (!process.env.SECRET_KEY && fs.existsSync(keyFile)) files.push({ name: 'secret.key', data: fs.readFileSync(keyFile) });
    files.push({ name: 'HUONG-DAN-KHOI-PHUC.txt', data: Buffer.from([
      'KHÔI PHỤC DỮ LIỆU EARNAPP MANAGER',
      '',
      'Cách dễ nhất: mở web mới → trang Sao lưu (menu bên trái) → "Chọn file sao lưu" → chọn file zip này.',
      '',
      'Làm tay (khi web không mở được):',
      '1. Tắt web (systemctl stop earnapp).',
      '2. Trong thư mục data/: xoá earnapp.db-wal và earnapp.db-shm nếu có.',
      '3. Chép earnapp.db' + (files.length > 1 ? ' và secret.key' : '') + ' từ file zip này vào thư mục data/ (ghi đè).',
      process.env.SECRET_KEY ? '   Web đang dùng SECRET_KEY trong .env: phải giữ đúng SECRET_KEY cũ, nếu không cookie các acc sẽ không đọc được.' : null,
      '4. Bật lại web (systemctl start earnapp).',
      '',
      'LƯU Ý: file này chứa cookie EarnApp' + (files.length > 1 ? ' và khoá để giải mã' : '') + '. Ai có file là truy cập được các acc, cần giữ kín.',
    ].filter(l => l !== null).join('\r\n'), 'utf8') });
    return { name: `earnapp-backup-${stamp()}.zip`, data: zip(files) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export class BackupError extends Error {}

/** Khoá sẽ dùng sau khi khôi phục: SECRET_KEY trong .env > khoá trong file sao lưu > khoá đang dùng */
function keyAfterRestore(zipKey) {
  if (process.env.SECRET_KEY) return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  const hex = (zipKey ?? fs.readFileSync(path.join(DATA_DIR, 'secret.key'))).toString('utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new BackupError('File secret.key trong file sao lưu bị hỏng');
  return Buffer.from(hex, 'hex');
}

/**
 * Bước 1 khôi phục: nhận file zip, kiểm tra kỹ (đúng database của web này, khoá đọc được cookie),
 * cất tạm vào data/restore-upload/, trả về tóm tắt để admin xem trước khi đồng ý. Chưa đổi gì.
 */
export function checkRestore(buf) {
  let files;
  try { files = unzip(buf); } catch (e) { throw new BackupError(e.message); }
  const dbFile = files.find(f => f.name === 'earnapp.db');
  if (!dbFile) throw new BackupError('Trong file không có earnapp.db. Chọn đúng file zip tải từ nút "Tải file sao lưu"');
  if (dbFile.data.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new BackupError('earnapp.db trong file không phải database hợp lệ');
  const keyFile = files.find(f => f.name === 'secret.key');

  fs.rmSync(UPLOAD, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD, { recursive: true });
  const dbPath = path.join(UPLOAD, 'earnapp.db');
  fs.writeFileSync(dbPath, dbFile.data);
  try {
    const key = keyAfterRestore(keyFile?.data);
    const b = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = new Set(b.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name));
      if (!tables.has('accounts') || !tables.has('settings')) throw new BackupError('Database trong file không phải của EarnApp Manager');
      const one = b.prepare("SELECT cookie_enc FROM accounts WHERE cookie_enc != '' LIMIT 1").get();
      if (one) {
        try { decryptWith(key, one.cookie_enc); } catch {
          throw new BackupError(process.env.SECRET_KEY
            ? 'Không đọc được cookie trong file sao lưu bằng SECRET_KEY hiện tại. Đặt SECRET_KEY trong .env giống web cũ rồi thử lại'
            : 'Không đọc được cookie trong file sao lưu (thiếu hoặc sai secret.key). Dùng đúng file zip tải từ web cũ');
        }
      }
      const n = (sql, ...a) => { try { return b.prepare(sql).get(...a)?.n ?? 0; } catch { return 0; } };
      const summary = {
        accounts: n('SELECT COUNT(*) AS n FROM accounts WHERE archived_at IS NULL'),
        archived: n('SELECT COUNT(*) AS n FROM accounts WHERE archived_at IS NOT NULL'),
        machines: n('SELECT COUNT(*) AS n FROM machines'),
        devices: n('SELECT COUNT(*) AS n FROM devices WHERE missing = 0'),
        last_data_at: n('SELECT MAX(last_ok_at) AS n FROM accounts') || null,
        has_key: !!keyFile,
        size: dbFile.data.length,
      };
      if (keyFile) fs.writeFileSync(path.join(UPLOAD, 'secret.key'), keyFile.data, { mode: 0o600 });
      return summary;
    } finally { b.close(); }
  } catch (e) {
    fs.rmSync(UPLOAD, { recursive: true, force: true });
    if (e instanceof BackupError) throw e;
    throw new BackupError('Không đọc được database trong file: ' + e.message);
  }
}

/** Bước 2: admin đồng ý. Đưa file vào hàng chờ, web tự khởi động lại và đổi dữ liệu lúc khởi động (config.js) */
export function applyRestore() {
  if (!fs.existsSync(path.join(UPLOAD, 'earnapp.db'))) throw new BackupError('Chưa có file sao lưu nào được kiểm tra. Chọn file lại');
  fs.rmSync(PENDING, { recursive: true, force: true });
  fs.renameSync(UPLOAD, PENDING);
  addEvent({ type: 'restore', level: 'warning', message: 'Khôi phục dữ liệu từ file sao lưu, web khởi động lại' });
}

export const cancelRestore = () => fs.rmSync(UPLOAD, { recursive: true, force: true });

// ================== 2. Xuất / nhập danh sách acc ==================

export const FORMAT = 'earnapp-manager-accounts';
const PW_MIN = 6;

const keyFrom = (password, salt) => crypto.scryptSync(String(password), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });

/** File JSON khoá bằng mật khẩu: máy + acc (kể cả acc lưu trữ) + cookie + proxy */
export function exportAccounts(password) {
  if (String(password || '').length < PW_MIN) throw new BackupError(`Mật khẩu file tối thiểu ${PW_MIN} ký tự`);
  const machines = db.prepare('SELECT name, note FROM machines ORDER BY id').all();
  const accounts = db.prepare('SELECT email, label, note, group_name, proxy, cookie_enc, paused, archived_at FROM accounts ORDER BY id').all()
    .map(a => ({ email: a.email, label: a.label, note: a.note, machine: a.group_name || '', proxy: a.proxy || '', cookie: decrypt(a.cookie_enc),
      paused: !!a.paused, archived: !!a.archived_at }));
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(password, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify({ machines, accounts }), 'utf8'), c.final()]);
  const file = {
    format: FORMAT, version: 1, exported_at: new Date().toISOString(),
    machines: machines.length, accounts: accounts.length, // chỉ để biết file có gì, không chứa thông tin acc
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
  return { name: `earnapp-danh-sach-acc-${stamp()}.json`, data: Buffer.from(JSON.stringify(file, null, 1)) };
}

/** Đọc file danh sách acc: sai định dạng / sai mật khẩu thì báo lỗi */
export function readAccountsFile(buf, password) {
  let f;
  try { f = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { throw new BackupError('File không đúng. Chọn file .json tải từ nút "Tải file acc"'); }
  if (f?.format !== FORMAT) {
    throw new BackupError('File không phải danh sách acc của EarnApp Manager. File sao lưu (.zip) thì dùng nút "Nhập file sao lưu"');
  }
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(password, Buffer.from(f.salt, 'base64')), Buffer.from(f.iv, 'base64'));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
  } catch { throw new BackupError('Sai mật khẩu file (hoặc file bị sửa)'); }
}

/**
 * Nhập danh sách acc vào web đang chạy: tạo máy còn thiếu; acc mới thì thêm, acc đã có (cùng email) thì
 * cập nhật cookie / proxy / máy / tên theo file. Không gọi EarnApp lúc nhập; tải dữ liệu chạy ngầm sau đó.
 */
export function importAccounts(buf, password) {
  const { machines = [], accounts = [] } = readAccountsFile(buf, password);
  let machinesAdded = 0, added = 0, updated = 0;
  const results = []; // acc cần tải dữ liệu ở nền
  tx(() => {
    for (const m of machines) {
      try { createMachine({ name: m.name, note: m.note }); machinesAdded++; } catch (e) { if (!(e instanceof MachineError)) throw e; } // đã có thì thôi
    }
    const find = db.prepare('SELECT id, group_name FROM accounts WHERE email = ?');
    const ins = db.prepare(`INSERT INTO accounts(email, label, note, group_name, cookie_enc, proxy, paused, archived_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const upd = db.prepare(`UPDATE accounts SET cookie_enc = ?, proxy = ?, group_name = ?, label = COALESCE(?, label), auth_state = 'pending'
      WHERE id = ?`);
    accounts.forEach((a, i) => {
      if (!a?.email || !a.cookie) return;
      let machine = '', proxy = '';
      try { machine = resolveMachine(a.machine); } catch { machine = ''; }
      try { proxy = normalizeProxy(a.proxy); } catch { proxy = ''; }
      const label = a.label ? String(a.label).slice(0, 40) : null;
      const dup = find.get(a.email);
      if (dup) {
        upd.run(encrypt(a.cookie), proxy, machine || dup.group_name || '', label, dup.id);
        updated++;
        results.push({ ok: true, id: dup.id, email: a.email, label, group_name: machine, updated: true, line: i + 1 });
        return;
      }
      const id = Number(ins.run(a.email, label, String(a.note || ''), machine, encrypt(a.cookie), proxy, a.paused || a.archived ? 1 : 0,
        a.archived ? Date.now() : null, a.archived ? 'stopped' : 'running', Date.now()).lastInsertRowid);
      added++;
      // Acc tạm ngừng / lưu trữ ở web cũ: giữ nguyên như vậy, không tải dữ liệu
      if (!a.paused && !a.archived) results.push({ ok: true, id, email: a.email, label, group_name: machine, updated: false, line: i + 1 });
    });
  });
  addEvent({ type: 'import', message: `Nhập từ file: ${added} acc mới, ${updated} acc cập nhật, ${machinesAdded} máy mới` });
  const job = results.length ? startImportJob(results) : null;
  return { added, updated, machines_added: machinesAdded, syncing: results.length, job };
}
