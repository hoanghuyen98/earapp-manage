// Test thêm acc hàng loạt: mỗi dòng cookie | tên | máy | proxy, kiểm tra song song, lưu đúng thứ tự (dữ liệu giả, không gọi EarnApp)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-add-'));

const { db } = await import('../server/db.js');
const { EarnAppClient, normalizeCookie } = await import('../server/earnapp.js');
const { createMachine } = await import('../server/machines.js');
const { parseLines, addAccounts } = await import('../server/addAccounts.js');

// Giả EarnApp: token "tokN" -> email "uN@x.com"; "bad" -> cookie hết hạn. Đếm số lần gọi cùng lúc.
let running = 0, peak = 0;
const proxies = [];
EarnAppClient.prototype.call = async function (name) {
  assert.equal(name, 'user_data');
  running++; peak = Math.max(peak, running);
  proxies.push(this.dispatcher ? 'proxy' : 'direct');
  await new Promise(r => setTimeout(r, 20));
  running--;
  const tok = this.cookie.match(/oauth-refresh-token=([^;]+)/)[1];
  if (tok === 'bad') throw new Error('auth required');
  return { email: `${tok.replace(/^tok/, 'u').replace(/b$/, '')}@x.com` };
};
const acc = email => db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);

createMachine({ name: 'Máy A' });
createMachine({ name: 'Máy B' });

// 1. Đọc dòng: cột cách bằng | hoặc Tab, bỏ dòng trống và dòng #
assert.deepEqual(parseLines('tok1\n\n# ghi chú\n tok2 | A2 | Máy B \ntok3\t\tmáy b\t1.2.3.4:8080'), [
  { no: 1, cookie: 'tok1', label: '', machine: '', proxy: '' },
  { no: 4, cookie: 'tok2', label: 'A2', machine: 'Máy B', proxy: '' },
  { no: 5, cookie: 'tok3', label: '', machine: 'máy b', proxy: '1.2.3.4:8080' },
]);

// 2. Thêm hàng loạt: máy chung + máy riêng từng dòng, tên riêng từng dòng, lỗi từng dòng không chặn dòng khác
const text = [
  'tok1',
  'tok2 | A2 | máy b',
  'tok3 | | | 1.2.3.4:8080',
  'bad',
  'tok4 | | Máy Z',
  'tok1',
  'không-có-token=1',
  'tok5', 'tok6', 'tok7',
].join('\n');
const r = await addAccounts(text, { group_name: 'Máy A', label: 'bỏ qua', note: 'lô 1' });
assert.equal(r.length, 10);
assert.ok(peak > 1 && peak <= 3, `kiểm tra song song tối đa 3 (đang ${peak})`);
assert.deepEqual(r.map(x => x.ok), [true, true, true, false, false, false, false, true, true, true]);
assert.deepEqual(r.map(x => x.line), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.match(r[4].error, /Chưa có máy "Máy Z"/);
assert.match(r[5].error, /Trùng cookie với dòng 1/);
assert.match(r[6].error, /oauth-refresh-token/);
assert.equal(acc('u1@x.com').group_name, 'Máy A');
assert.equal(acc('u1@x.com').label, null, 'thêm nhiều acc: tên chung không áp dụng');
assert.equal(acc('u1@x.com').note, 'lô 1');
assert.equal(acc('u2@x.com').group_name, 'Máy B', 'máy riêng của dòng, tên chuẩn');
assert.equal(acc('u2@x.com').label, 'A2');
assert.equal(acc('u3@x.com').proxy, 'http://1.2.3.4:8080');
assert.equal(acc('u1@x.com').proxy, '');
assert.equal(proxies.filter(p => p === 'proxy').length, 1);
// 2 dòng khác cookie nhưng cùng email (kiểm tra song song): chỉ 1 acc, dòng sau là cập nhật
const same = await addAccounts([{ cookie: 'tok20' }, { cookie: 'tok20b' }], { group_name: 'Máy A' });
assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts WHERE email = 'u20@x.com'").get().n, 1);
assert.equal(same.filter(x => x.updated).length, 1);

// 3. Thêm lại acc đã có (cookie mới cùng email): cập nhật cookie, chuyển máy, không tạo acc mới
const before = db.prepare('SELECT COUNT(*) n FROM accounts').get().n;
const r2 = await addAccounts('tok1b | A1 | Máy B', { group_name: 'Máy A' });
assert.equal(r2[0].updated, true);
assert.equal(r2[0].moved, 'Máy B');
assert.equal(acc('u1@x.com').label, 'A1');
assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, before);

// 4. 1 acc: tên chung trên form vẫn dùng như cũ
await addAccounts('tok8', { group_name: 'Máy A', label: 'Tám' });
assert.equal(acc('u8@x.com').label, 'Tám');

// 5. Form gửi mảng acc, mỗi acc tên và proxy riêng, dòng trống bỏ qua, số dòng tính theo mảng
const r3 = await addAccounts([{ cookie: 'tok9', label: 'B1', proxy: '5.6.7.8:3128:u:p' }, { cookie: ' ' }, { cookie: 'tok10', label: 'B2', proxy: 'socks5://9.9.9.9:1080' }, { cookie: 'tok9', label: 'B3' }, { cookie: 'tok11', proxy: 'sai proxy' }], { group_name: 'Máy B' });
assert.deepEqual(r3.map(x => [x.ok, x.line]), [[true, 1], [true, 3], [false, 4], [false, 5]]);
assert.match(r3[3].error, /Proxy/, 'proxy sai chỉ hỏng acc đó');
assert.equal(acc('u9@x.com').proxy, 'http://u:p@5.6.7.8:3128', 'mỗi acc 1 proxy riêng');
assert.equal(acc('u10@x.com').proxy, 'socks5://9.9.9.9:1080');
assert.equal(acc('u9@x.com').label, 'B1');
assert.equal(acc('u10@x.com').group_name, 'Máy B');

// 6. Lỗi chung cả lô
await assert.rejects(addAccounts('  \n# chỉ ghi chú', {}), /Chưa nhập cookie/);
await assert.rejects(addAccounts('tok1', { group_name: 'Không có' }), /Chưa có máy/);
await assert.rejects(addAccounts('tok1', { proxy: 'ftp://x' }), /Proxy/);

// Cookie dán từ trình duyệt: dùng nguyên văn, không lọc bỏ / thêm phần nào (thiếu brd_sess_id là có acc bị báo auth required)
const pasted = '__cf_bm=x; _ga=1; xsrf-token=X; brd_sess_id=S; auth=1; oauth-token=T; oauth-refresh-token=R; ui_testing=u';
assert.equal(normalizeCookie(pasted), pasted);
assert.equal(normalizeCookie(`  Cookie: ${pasted}\n`), pasted, 'chỉ bỏ chữ "Cookie:" và khoảng trắng 2 đầu');
assert.equal(normalizeCookie('R'), 'oauth-refresh-token=R; auth=1; auth-method=google', 'dán mỗi token');
assert.throws(() => normalizeCookie('_ga=1; auth=1'), /oauth-refresh-token/);

console.log('✓ test-add-accounts: tất cả đều đúng');
