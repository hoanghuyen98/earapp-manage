// Test thêm acc chạy ngầm: trả về ngay, kiểm tra + tải dữ liệu ở nền, chạy tiếp sau khi web khởi động lại,
// thử lại dòng lỗi, tin Telegram cho cả lượt (dữ liệu giả, không gọi EarnApp, không gửi Telegram)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-job-'));

const { db, setSettings } = await import('../server/db.js');
const { encrypt, decrypt } = await import('../server/crypto.js');
const { EarnAppClient } = await import('../server/earnapp.js');
const { createMachine } = await import('../server/machines.js');
const jobs = await import('../server/addJobs.js');

// Không bao giờ gửi Telegram thật trong test
setSettings({ telegram_token: '', telegram_chat_id: '', account_delay_sec: 0 });
globalThis.fetch = async () => { throw new Error('test không được gọi mạng'); };

// Giả EarnApp: "tokN" -> uN@x.com, "bad" -> cookie hết hạn, "slow" chờ lâu hơn. Đếm số lần kiểm tra cookie
const checks = [];
let netDown = false;
EarnAppClient.prototype.call = async function (name) {
  assert.equal(name, 'user_data');
  const tok = this.cookie.match(/oauth-refresh-token=([^;]+)/)[1];
  checks.push(tok);
  await new Promise(r => setTimeout(r, tok === 'slow' ? 120 : 30));
  if (tok === 'bad') throw new Error('auth required');
  if (netDown && tok.startsWith('net')) throw new Error('Không kết nối được EarnApp qua proxy: quá thời gian không phản hồi');
  return { email: `${tok.replace(/^tok/, 'u')}@x.com` };
};
let syncFail = new Set();
EarnAppClient.prototype.fetchAll = async function () {
  const tok = this.cookie.match(/oauth-refresh-token=([^;]+)/)[1];
  await new Promise(r => setTimeout(r, 30));
  if (syncFail.has(tok)) throw new Error('Không kết nối được EarnApp qua proxy: quá thời gian không phản hồi');
  return { user: { email: `${tok}@x.com` }, money: { balance: 1, earnings_total: 2 }, devices: [], statuses: {}, transactions: [], usage: [], usageMonthly: null };
};
const waitJob = id => jobs.runJob(id);
const job = id => jobs.listJobs().find(j => j.id === id);

createMachine({ name: 'Máy A' });

// 1. Bấm Thêm: trả về ngay, chưa kiểm tra cookie nào; sai phần chung thì báo lỗi ngay
assert.throws(() => jobs.startAddJob([{ cookie: 'tok1' }], { group_name: 'Không có' }), /Chưa có máy/);
assert.throws(() => jobs.startAddJob([], { group_name: 'Máy A' }), /Chưa nhập cookie/);
syncFail = new Set(['tok3']);
const t0 = Date.now();
const j1 = jobs.startAddJob([
  { cookie: 'tok1', label: 'A1', proxy: 'socks5://1.1.1.1:1080' },
  { cookie: 'bad', label: 'A2' },
  { cookie: 'tok3', label: 'A3', proxy: 'socks5://3.3.3.3:1080' },
  { cookie: 'không-có-token=1' },
  { cookie: 'slow', label: 'A5', proxy: 'socks5://5.5.5.5:1080' },
], { group_name: 'Máy A' });
assert.ok(Date.now() - t0 < 50, 'trả về ngay, không chờ EarnApp');
assert.equal(j1.total, 5);
assert.equal(j1.checked, 0);
assert.equal(j1.finished_at, null);
assert.ok(decrypt(db.prepare('SELECT rows_enc FROM add_jobs WHERE id = ?').get(j1.id).rows_enc).includes('tok1'), 'cookie lưu dạng mã hoá');
assert.ok(!db.prepare('SELECT rows_enc FROM add_jobs WHERE id = ?').get(j1.id).rows_enc.includes('tok1'));

// 2. Chạy ngầm: acc kiểm tra xong là có trong danh sách acc ngay, không chờ cả lô
await new Promise(r => setTimeout(r, 60));
const mid = job(j1.id);
assert.ok(mid.checked >= 1 && mid.checked < 5, `đang chạy: đã kiểm tra ${mid.checked}/5`);
assert.ok(db.prepare("SELECT 1 FROM accounts WHERE email = 'u1@x.com'").get(), 'acc đầu đã vào danh sách');
await waitJob(j1.id);
const v1 = job(j1.id);
assert.ok(v1.finished_at, 'xong');
assert.deepEqual([v1.added, v1.updated, v1.failed, v1.loaded, v1.sync_failed], [3, 0, 2, 2, 1]);
assert.deepEqual(v1.items.map(r => r.line), [1, 2, 3, 4, 5], 'kết quả theo thứ tự dòng');
assert.equal(v1.items[1].reason, 'Cookie sai hoặc đã hết hạn');
assert.equal(v1.items[1].label, 'A2', 'dòng lỗi vẫn giữ tên để biết là acc nào');
assert.equal(v1.items[2].sync.state, 'error', 'thêm được nhưng tải dữ liệu lỗi');
assert.equal(v1.retryable, 0, 'lỗi đều do cookie: không có gì để thử lại');
// Xong rồi chỉ giữ cookie của dòng lỗi
const kept = decrypt(db.prepare('SELECT rows_enc FROM add_jobs WHERE id = ?').get(j1.id).rows_enc);
assert.ok(kept.includes('bad') && !kept.includes('tok1') && !kept.includes('slow'), 'chỉ giữ dòng lỗi');

// 3. Tin Telegram cho cả lượt: ngắn, có lý do + việc cần làm (in ra xem, không gửi)
const msg = jobs.formatAddJob(v1);
console.log('----- Tin Telegram (xem trước) -----\n' + msg + '\n------------------------------------');
assert.match(msg, /^⚠️ <b>Thêm acc xong · Máy A<\/b>/);
assert.match(msg, /3 acc mới, đã tải dữ liệu 2 acc/);
assert.match(msg, /❌ 2 acc không thêm được/);
assert.match(msg, /Acc 2 \(A2\): Cookie sai hoặc đã hết hạn/);
assert.match(msg, /1 acc đã thêm nhưng chưa lấy được dữ liệu/);
assert.match(msg, /👉 Acc lỗi cookie: lấy cookie mới/);
assert.ok(!/Thử lại/.test(msg), 'lỗi đều do cookie: không bảo bấm Thử lại (thử lại cookie cũ vô ích)');
assert.ok(msg.split('\n').length <= 12, 'tin ngắn');
const okMsg = jobs.formatAddJob({ ...v1, failed: 0, sync_failed: 0, items: v1.items.filter(r => r.ok && r.sync?.state === 'done'), added: 2, loaded: 2 });
assert.match(okMsg, /^✅/);
assert.ok(!/👉/.test(okMsg), 'không lỗi thì không có việc cần làm');
// Lượt nhiều lỗi: chỉ liệt kê 5 dòng
const many = jobs.formatAddJob({ ...v1, failed: 20, items: Array.from({ length: 20 }, (_, i) => ({ ok: false, line: i + 1, reason: 'Không kết nối được qua proxy: x' })) });
assert.match(many, /… và 15 acc khác/);
assert.match(many, /lỗi mạng \/ proxy: kiểm tra proxy rồi bấm "Thử lại"/);

// 4. Thử lại: chỉ các dòng lỗi mạng / proxy (lỗi cookie thử lại cũng vô ích), lượt cũ được đóng, cookie không trả về trình duyệt
assert.throws(() => jobs.retryJob(j1.id), /Không còn acc lỗi mạng/, 'lượt chỉ có lỗi cookie: không thử lại');
netDown = true;
const jn = jobs.startAddJob([{ cookie: 'net9', label: 'N1', proxy: 'socks5://9.9.9.9:1080' }, { cookie: 'bad', label: 'N2' }], { group_name: 'Máy A' });
await waitJob(jn.id);
assert.equal(job(jn.id).failed, 2);
assert.equal(job(jn.id).retryable, 1, '1 lỗi mạng, 1 lỗi cookie');
netDown = false;
checks.length = 0;
const j2 = jobs.retryJob(jn.id);
assert.equal(j2.total, 1, 'chỉ thử lại acc lỗi mạng');
assert.ok(!job(jn.id), 'lượt cũ đã đóng');
assert.equal(db.prepare('SELECT rows_enc FROM add_jobs WHERE id = ?').get(jn.id).rows_enc, '', 'đóng thì xoá cookie còn giữ');
assert.ok(!JSON.stringify(j2).includes('net9'), 'kết quả gửi về trình duyệt không chứa cookie');
await waitJob(j2.id);
assert.deepEqual(checks, ['net9']);
assert.equal(job(j2.id).added, 1, 'mạng ổn lại thì thêm được');
assert.equal(job(j2.id).items[0].label, 'N1', 'giữ tên và proxy của dòng cũ');
assert.equal(db.prepare("SELECT proxy FROM accounts WHERE email = 'net9@x.com'").get().proxy, 'socks5://9.9.9.9:1080');

// 5. Web khởi động lại giữa chừng: chạy tiếp dòng chưa xong, không kiểm tra lại dòng đã xong
const rows = [{ no: 1, cookie: 'tok7', label: 'B1' }, { no: 2, cookie: 'tok8', label: 'B2' }];
const done = [{ ok: true, email: 'u7@x.com', id: Number(db.prepare("INSERT INTO accounts(email, cookie_enc, group_name, created_at) VALUES ('u7@x.com', ?, 'Máy A', ?)")
  .run(encrypt('oauth-refresh-token=tok7'), Date.now()).lastInsertRowid), label: 'B1', line: 1 }];
const jid = Number(db.prepare('INSERT INTO add_jobs(created_at, group_name, total, rows_enc, results) VALUES (?, ?, ?, ?, ?)')
  .run(Date.now(), 'Máy A', 2, encrypt(JSON.stringify({ rows, defaults: { group_name: 'Máy A' } })), JSON.stringify(done)).lastInsertRowid);
checks.length = 0;
jobs.resumeJobs();
await waitJob(jid);
const v3 = job(jid);
assert.deepEqual(checks, ['tok8'], 'chỉ kiểm tra dòng chưa xong');
assert.ok(v3.finished_at);
assert.equal(v3.added, 2);
assert.equal(v3.loaded, 2, 'acc đã lưu trước khi tắt web cũng được tải dữ liệu');

// 6. Đóng thông báo
jobs.dismissJob(jid);
assert.ok(!job(jid));

console.log('✓ test-add-jobs: tất cả đều đúng');
process.exit(0);
