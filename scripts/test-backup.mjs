// Test sao lưu / khôi phục toàn bộ và xuất / nhập danh sách acc (dữ liệu giả, không gọi EarnApp, không gửi Telegram)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-bak-'));
delete process.env.SECRET_KEY;
const DIR = process.env.DATA_DIR;

const { applyPendingRestore } = await import('../server/config.js');
const { db, setSettings } = await import('../server/db.js');
const { encrypt, decrypt } = await import('../server/crypto.js');
const { EarnAppClient } = await import('../server/earnapp.js');
const { createMachine } = await import('../server/machines.js');
const { zip, unzip } = await import('../server/zip.js');
const { runJob, listJobs } = await import('../server/addJobs.js');
const bak = await import('../server/backup.js');

setSettings({ telegram_token: '', telegram_chat_id: '', account_delay_sec: 0 });
globalThis.fetch = async () => { throw new Error('test không được gọi mạng'); };
let synced = [];
EarnAppClient.prototype.fetchAll = async function () {
  const tok = this.cookie.match(/oauth-refresh-token=([^;]+)/)[1];
  synced.push(tok);
  return { user: { email: tok.replace('tok-', '').toLowerCase() + '@x.com' }, money: { balance: 1, earnings_total: 2 }, devices: [], statuses: {}, transactions: [], usage: [], usageMonthly: null };
};
EarnAppClient.prototype.call = async () => { throw new Error('nhập từ file không được kiểm tra lại cookie'); };

// Dữ liệu web cũ: 2 máy, 4 acc (1 tạm ngừng, 1 lưu trữ), có proxy và tên riêng
createMachine({ name: 'Máy A', note: 'nhà' });
createMachine({ name: 'VPS-B' });
const add = (email, label, machine, proxy, extra = '') => db.prepare(`INSERT INTO accounts(email, label, note, group_name, cookie_enc, proxy, created_at${extra ? ', ' + extra : ''})
  VALUES (?, ?, 'ghi chú', ?, ?, ?, ?${extra ? ', 1' : ''})`).run(email, label, machine, encrypt(`oauth-refresh-token=tok-${label}; auth=1`), proxy, Date.now());
add('a1@x.com', 'A1', 'Máy A', 'socks5://u:p@1.1.1.1:1080');
add('a2@x.com', 'A2', 'Máy A', 'http://2.2.2.2:8080');
add('b1@x.com', 'B1', 'VPS-B', '', 'paused');
add('old@x.com', 'OLD', 'VPS-B', '', 'archived_at');
db.exec('UPDATE accounts SET paused = 1 WHERE archived_at IS NOT NULL'); // web luôn tạm ngừng acc lưu trữ
const accs = () => db.prepare('SELECT * FROM accounts ORDER BY email').all();
const before = accs();

// ===== Xuất / nhập danh sách acc =====
assert.throws(() => bak.exportAccounts('123'), /tối thiểu 6/);
const f = bak.exportAccounts('mat-khau-123');
assert.match(f.name, /^earnapp-danh-sach-acc-.*\.json$/);
const text = f.data.toString();
assert.ok(!text.includes('tok-A1') && !text.includes('a1@x.com') && !text.includes('1.1.1.1'), 'file không lộ cookie, email, proxy');
assert.equal(JSON.parse(text).accounts, 4);
assert.throws(() => bak.readAccountsFile(f.data, 'sai-mat-khau'), /Sai mật khẩu/);
assert.throws(() => bak.readAccountsFile(Buffer.from('xyz'), 'x'), /File không đúng/);
assert.throws(() => bak.readAccountsFile(Buffer.from('{"a":1}'), 'x'), /không phải danh sách acc/);

// Web mới (trống): nhập file -> có lại đủ máy, acc, cookie, proxy, tên; không kiểm tra lại từng cookie
db.exec('DELETE FROM accounts; DELETE FROM machines;');
const r = bak.importAccounts(f.data, 'mat-khau-123');
assert.deepEqual([r.added, r.updated, r.machines_added, r.syncing], [4, 0, 2, 2], '4 acc, 2 máy; chỉ tải dữ liệu 2 acc đang chạy');
const after = accs();
for (const k of ['email', 'label', 'note', 'group_name', 'proxy', 'paused']) assert.deepEqual(after.map(a => a[k]), before.map(a => a[k]), `giữ đúng ${k}`);
assert.deepEqual(after.map(a => decrypt(a.cookie_enc)), before.map(a => decrypt(a.cookie_enc)), 'giữ đúng cookie');
assert.ok(after.find(a => a.email === 'old@x.com').archived_at, 'acc lưu trữ vẫn lưu trữ');
assert.equal(db.prepare("SELECT note FROM machines WHERE name = 'Máy A'").get().note, 'nhà');
// Tải dữ liệu chạy ngầm như thêm acc: có thẻ thông báo, xong thì báo
assert.equal(r.job.kind, 'import');
await runJob(r.job.id);
const job = listJobs().find(j => j.id === r.job.id);
assert.ok(job.finished_at);
assert.equal(job.loaded, 2);
assert.deepEqual(synced.sort(), ['tok-A1', 'tok-A2'], 'acc tạm ngừng / lưu trữ không tải dữ liệu');

// Nhập lại lần nữa: không tạo trùng, chỉ cập nhật
const r2 = bak.importAccounts(f.data, 'mat-khau-123');
assert.deepEqual([r2.added, r2.updated, r2.machines_added], [0, 4, 0]);
assert.equal(accs().length, 4);
await runJob(r2.job.id);

// ===== Sao lưu / khôi phục toàn bộ =====
const backup = bak.makeBackup();
const files = unzip(backup.data);
assert.deepEqual(files.map(x => x.name).sort(), ['HUONG-DAN-KHOI-PHUC.txt', 'earnapp.db', 'secret.key']);

// File sai: báo lỗi rõ, không đổi gì
assert.throws(() => bak.checkRestore(Buffer.from('không phải zip')), /không phải file zip/);
assert.throws(() => bak.checkRestore(zip([{ name: 'a.txt', data: Buffer.from('x') }])), /không có earnapp.db/);
assert.throws(() => bak.checkRestore(zip([{ name: 'earnapp.db', data: Buffer.from('rác') }])), /không phải database/);
// Database của phần mềm khác
const other = path.join(os.tmpdir(), `other-${Date.now()}.db`);
{ const o = new DatabaseSync(other); o.exec('CREATE TABLE t (x)'); o.close(); }
assert.throws(() => bak.checkRestore(zip([{ name: 'earnapp.db', data: fs.readFileSync(other) }])), /không phải của EarnApp Manager/);
// Khoá khác (file của web khác mà thiếu / sai secret.key): không đọc được cookie -> không cho khôi phục
const wrongKey = zip([files.find(x => x.name === 'earnapp.db'), { name: 'secret.key', data: Buffer.from(crypto.randomBytes(32).toString('hex')) }]);
assert.throws(() => bak.checkRestore(wrongKey), /Không đọc được cookie/);
assert.ok(!fs.existsSync(path.join(DIR, 'restore-upload')), 'file lỗi không để lại gì');
assert.throws(() => bak.applyRestore(), /Chưa có file sao lưu/);

// Nén lại bằng công cụ khác, có thư mục bên trong: vẫn đọc được
const nested = zip(files.map(x => ({ name: 'earnapp-backup/' + x.name, data: x.data })));
const sum = bak.checkRestore(nested);
assert.deepEqual([sum.accounts, sum.archived, sum.machines, sum.has_key], [3, 1, 2, true]);
bak.cancelRestore();
assert.ok(!fs.existsSync(path.join(DIR, 'restore-upload')), 'huỷ thì xoá file tạm');

// Khôi phục thật: sửa dữ liệu hiện tại, khôi phục file cũ, khởi động lại -> về đúng dữ liệu trong file, dữ liệu trước đó được cất lại
bak.checkRestore(backup.data);
db.exec("DELETE FROM accounts WHERE email = 'a1@x.com'");
bak.applyRestore();
assert.ok(fs.existsSync(path.join(DIR, 'restore-pending', 'earnapp.db')));
const keyBefore = fs.readFileSync(path.join(DIR, 'secret.key'), 'utf8');
const oldDir = applyPendingRestore(DIR); // việc config.js làm lúc web khởi động
assert.ok(oldDir && fs.existsSync(path.join(oldDir, 'earnapp.db')), 'dữ liệu trước khi khôi phục được cất lại');
assert.ok(!fs.existsSync(path.join(DIR, 'restore-pending')));
const restored = new DatabaseSync(path.join(DIR, 'earnapp.db'), { readOnly: true });
assert.ok(restored.prepare("SELECT 1 FROM accounts WHERE email = 'a1@x.com'").get(), 'acc đã xoá có lại');
assert.equal(restored.prepare('SELECT COUNT(*) n FROM accounts').get().n, 4);
restored.close();
assert.equal(fs.readFileSync(path.join(DIR, 'secret.key'), 'utf8'), keyBefore, 'khoá đúng của file sao lưu');
assert.equal(applyPendingRestore(DIR), null, 'không có gì chờ thì không làm gì');

console.log('✓ test-backup: tất cả đều đúng');
process.exit(0);
