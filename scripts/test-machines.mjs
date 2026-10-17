// Test nghiệp vụ Máy: tạo máy trước, acc chọn máy, đổi tên / xoá / chuyển acc, chuyển dữ liệu cũ (dữ liệu giả)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-mac-'));

// DB kiểu cũ: máy là ô chữ tự gõ, có khoảng trắng thừa và viết hoa/thường lẫn lộn
{
  const old = new DatabaseSync(path.join(process.env.DATA_DIR, 'earnapp.db'));
  old.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, label TEXT, note TEXT DEFAULT '', group_name TEXT DEFAULT '',
    cookie_enc TEXT NOT NULL, proxy TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'running', status_mode TEXT NOT NULL DEFAULT 'auto',
    auth_state TEXT NOT NULL DEFAULT 'pending', last_error TEXT DEFAULT '', last_sync_at INTEGER, balance REAL DEFAULT 0,
    earnings_total REAL DEFAULT 0, joined_at TEXT, banned_at INTEGER, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  const ins = old.prepare('INSERT INTO accounts(email, label, group_name, cookie_enc, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('a1@x.com', 'A1', 'Máy A', 'x', 1);
  ins.run('a2@x.com', 'A2', ' Máy A  ', 'x', 2);
  ins.run('a3@x.com', 'A3', 'MÁY A', 'x', 3);
  ins.run('b1@x.com', 'B1', 'VPS-B', 'x', 4);
  ins.run('n1@x.com', null, '', 'x', 5);
  old.close();
}

const { db } = await import('../server/db.js');
const m = await import('../server/machines.js');
const groupOf = email => db.prepare('SELECT group_name g FROM accounts WHERE email = ?').get(email).g;

// 1. Chuyển dữ liệu cũ: mỗi tên máy thành 1 máy, bỏ khoảng trắng thừa, "MÁY A" và "Máy A" gộp 1
const names = db.prepare('SELECT name FROM machines ORDER BY id').all().map(r => r.name);
assert.deepEqual(names, ['Máy A', 'VPS-B']);
assert.equal(groupOf('a2@x.com'), 'Máy A', 'bỏ khoảng trắng thừa');
assert.equal(groupOf('a3@x.com'), 'Máy A', 'chữ hoa có dấu gộp vào cùng máy');
assert.ok(db.prepare("SELECT COUNT(*) n FROM accounts WHERE group_name != '' AND group_name NOT IN (SELECT name FROM machines)").get().n === 0, 'acc nào có máy cũng trỏ đúng máy');

// 2. Tạo máy: bắt buộc tên, không trùng (không phân biệt hoa/thường với chữ không dấu), không dùng tên dành riêng
const c = m.createMachine({ name: '  Máy   C ', note: 'node1->node20' });
assert.equal(c.name, 'Máy C');
assert.throws(() => m.createMachine({ name: 'vps-b' }), /Đã có máy "VPS-B"/);
assert.throws(() => m.createMachine({ name: '  ' }), /Chưa nhập tên máy/);
assert.throws(() => m.createMachine({ name: 'chưa gán máy' }), /tên dành riêng/);
assert.throws(() => m.createMachine({ name: 'x'.repeat(41) }), /tối đa 40/);

// 3. Chọn máy cho acc: chỉ được chọn máy đã tạo, trả về tên chuẩn
assert.equal(m.resolveMachine('vps-b'), 'VPS-B');
assert.equal(m.resolveMachine(''), '');
assert.throws(() => m.resolveMachine('Máy Z'), /Chưa có máy "Máy Z"/);

// 4. Danh sách máy: có cả máy chưa có acc, "Chưa gán máy" ở cuối
let list = m.listMachines();
const cRow = list.find(x => x.name === 'Máy C');
assert.equal(cRow.accounts, 0, 'máy mới chưa có acc vẫn hiện');
assert.equal(list.at(-1).name, '', 'chưa gán máy ở cuối');
assert.equal(list.at(-1).accounts, 1);
assert.equal(list.find(x => x.name === 'Máy A').accounts, 3);

// 5. Chuyển acc sang máy khác
assert.equal(m.moveAccounts([db.prepare("SELECT id FROM accounts WHERE email = 'n1@x.com'").get().id], 'máy c'), 1);
assert.equal(groupOf('n1@x.com'), 'Máy C');
assert.throws(() => m.moveAccounts([1], 'Không có'), /Chưa có máy/);
assert.throws(() => m.moveAccounts([], 'Máy C'), /Chưa chọn acc/);
assert.ok(!m.listMachines().some(x => x.name === ''), 'hết acc chưa gán thì không còn dòng "Chưa gán máy"');

// 6. Đổi tên máy: mọi acc đổi theo
const a = db.prepare("SELECT * FROM machines WHERE name = 'Máy A'").get();
m.updateMachine(a.id, { name: 'Máy A1-A3', note: 'VPS Hà Nội' });
assert.equal(groupOf('a1@x.com'), 'Máy A1-A3');
assert.equal(groupOf('a3@x.com'), 'Máy A1-A3');
assert.throws(() => m.createMachine({ name: 'MÁY A1-A3' }), /Đã có máy/, 'trùng tên khác hoa/thường có dấu');
assert.equal(m.getMachine(a.id).note, 'VPS Hà Nội');
assert.throws(() => m.updateMachine(a.id, { name: 'VPS-B' }), /Đã có máy/);
assert.equal(groupOf('a1@x.com'), 'Máy A1-A3', 'đổi tên lỗi thì không đổi gì');
m.updateMachine(a.id, { name: 'máy a1-a3' }); // chỉ đổi hoa/thường vẫn được
assert.equal(groupOf('a1@x.com'), 'máy a1-a3');

// 7. Xoá máy: còn acc thì không cho xoá; acc đã lưu trữ thì về "Chưa gán máy"
const b = db.prepare("SELECT * FROM machines WHERE name = 'VPS-B'").get();
assert.throws(() => m.deleteMachine(b.id), /"VPS-B" còn 1 acc/);
db.prepare("UPDATE accounts SET archived_at = 1 WHERE email = 'b1@x.com'").run();
m.deleteMachine(b.id);
assert.equal(m.getMachine(b.id), undefined);
assert.equal(groupOf('b1@x.com'), '', 'acc lưu trữ về chưa gán máy');
assert.throws(() => m.deleteMachine(9999), /Không tìm thấy/);

console.log('✓ test-machines: tất cả đều đúng');
