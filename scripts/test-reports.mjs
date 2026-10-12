// Test số liệu Tổng quan / Báo cáo bằng dữ liệu giả nhiều acc, nhiều ngày
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-rep-'));

const { db, setSettings, getSettings } = await import('../server/db.js');
const { localDate, addDays } = await import('../server/stats.js');
const { overview, report, scopeIds } = await import('../server/reports.js');

setSettings({ usd_vnd: 25000 });
const today = localDate(Date.now(), getSettings().timezone);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// 3 acc: A, B (nhóm VPS), C (nhóm Nhà, bị khoá)
const addAcc = (email, label, group, status, balance, total) => Number(db.prepare(
  `INSERT INTO accounts(email, label, group_name, status, balance, earnings_total, cookie_enc, created_at, auth_state) VALUES (?, ?, ?, ?, ?, ?, 'x', ?, 'ok')`)
  .run(email, label, group, status, balance, total, Date.now()).lastInsertRowid);
const A = addAcc('a@x.com', 'Acc A', 'VPS', 'running', 3, 30);
const B = addAcc('b@x.com', null, 'VPS', 'stopped', 1, 10);
const C = addAcc('c@x.com', 'Acc C', 'Nhà', 'banned', 2, 5);

// Thu nhập theo ngày: A kiếm 1$/ngày, B 0.5$/ngày trong 20 ngày qua; C 0.2$/ngày
const daily = db.prepare('INSERT INTO account_daily(account_id, date, first_total, last_total) VALUES (?, ?, ?, ?)');
for (let i = 0; i < 20; i++) {
  const d = addDays(today, -i);
  daily.run(A, d, 100, 101);
  daily.run(B, d, 50, 50.5);
  daily.run(C, d, 10, 10.2);
}
// Máy + uptime
const dev = db.prepare(`INSERT INTO devices(uuid, account_id, title, country, status, online, first_seen_at, updated_at, status_changed_at, last_online_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`);
dev.run('a1', A, 'node-a1', 'us', 'online', 1, 0, Date.now());
dev.run('a2', A, 'node-a2', 'vn', 'offline', 0, Date.now() - 3600e3, Date.now() - 3600e3);
dev.run('b1', B, 'node-b1', 'us', 'idle', 1, 0, Date.now());
dev.run('c1', C, 'node-c1', 'us', 'banned', 0, Date.now() - 1000, null);
const dd = db.prepare('INSERT INTO device_daily(uuid, date, first_total, last_total, check_n, online_n) VALUES (?, ?, ?, ?, ?, ?)');
dd.run('a1', today, 1, 1.8, 10, 10);
dd.run('a2', today, 1, 1.2, 10, 5);
dd.run('b1', today, 1, 1.5, 10, 10);
// Dung lượng
const us = db.prepare('INSERT INTO device_usage(uuid, account_id, date, bytes) VALUES (?, ?, ?, ?)');
for (let i = 0; i < 20; i++) { us.run('a1', A, addDays(today, -i), 1e9); us.run('b1', B, addDays(today, -i), 0.5e9); }
// Rút tiền
db.prepare(`INSERT INTO transactions(uuid, account_id, status, date, payment_method, payment_date, amount, fee) VALUES ('t1', ?, 'paid', ?, 'paypal.com', ?, 10, 0.2)`).run(A, addDays(today, -5), addDays(today, -3) + 'T10:00:00Z');
db.prepare(`INSERT INTO transactions(uuid, account_id, status, date, payment_method, amount) VALUES ('t2', ?, 'pending_procedure', ?, 'paypal.com', 4)`).run(B, today);
// Chi phí: 300.000đ/tháng
db.prepare("INSERT INTO costs(name, amount, period, date) VALUES ('VPS', 300000, 'monthly', ?)").run(addDays(today, -400));
// Bản lưu số dư 3 giờ trước: A kiếm thêm 0.3$ trong 3 giờ -> 0.1$/giờ
db.prepare('INSERT INTO balance_snapshots(account_id, ts, balance, earnings_total) VALUES (?, ?, ?, ?)').run(A, Date.now() - 3 * 3600e3, 2.7, 29.7);
db.prepare('INSERT INTO balance_snapshots(account_id, ts, balance, earnings_total) VALUES (?, ?, ?, ?)').run(B, Date.now() - 3 * 3600e3, 1, 10);

// ===== Phạm vi lọc =====
assert.equal(scopeIds({}), null, 'không lọc = tất cả');
assert.deepEqual(scopeIds({ group: 'VPS' }), [A, B]);
assert.deepEqual(scopeIds({ acc: `${A},${C}`, group: 'VPS' }), [A], 'lọc acc + nhóm = giao nhau');
assert.deepEqual(scopeIds({ acc: '1;DROP TABLE' }), [], 'id rác bị loại bỏ');

// ===== Tổng quan: tất cả =====
let o = overview({});
assert.equal(o.lifetime, 45);
assert.equal(o.current, 4, 'số dư hiện tại không tính acc bị khoá');
assert.equal(o.banned, 2);
assert.equal(o.withdrawn, 10);
assert.equal(o.pending, 4);
near(o.today, 1.7);
near(o.yesterday, 1.7);
near(o.rate_per_hour, 0.1, 1e-3);
assert.ok(o.forecast_today >= o.today, 'dự báo hôm nay >= đã kiếm');
assert.ok(o.forecast_month > o.month, 'dự báo tháng > đã kiếm');
near(o.uptime_today, 25 / 30, 1e-9);
assert.deepEqual(o.devices, { online: 1, idle: 1, offline: 1, banned: 1 });
assert.equal(o.rows.length, 3);
assert.equal(o.rows.find(r => r.id === B).name, 'b@x.com', 'không có tên thì dùng email');
near(o.rows.find(r => r.id === A).d7, 7);
assert.equal(o.groups.length, 2, 'có 2 nhóm');
near(o.groups.find(g => g.group === 'VPS').today, 1.5);
const series = o.daily.series.map(x => x.name);
assert.deepEqual(series, ['Acc A', 'b@x.com', 'Acc C'], 'xếp acc theo thu nhập');
near(o.daily.data.at(-1).value, 1.7);
assert.ok(o.attention.some(x => x.type === 'device_offline' && x.devices.includes('node-a2')), 'cần xử lý: máy rớt');
assert.ok(o.attention.some(x => x.type === 'device_idle'), 'cần xử lý: máy không ra tiền');
assert.ok(!o.attention.some(x => x.account_id === C), 'acc đã bị khoá không làm phiền ở Cần xử lý');

// ===== Tổng quan: lọc 1 acc / 1 nhóm =====
o = overview({ acc: String(A) });
assert.equal(o.lifetime, 30);
near(o.today, 1);
assert.equal(o.rows.length, 1);
assert.equal(o.pending, 0);
o = overview({ group: 'VPS' });
assert.equal(o.lifetime, 40);
near(o.today, 1.5);
assert.equal(o.withdrawn, 10);

// ===== Báo cáo 7 ngày =====
let r = report({ from: addDays(today, -6), to: today });
assert.equal(r.days, 7);
near(r.summary.earned, 7 * 1.7);
near(r.summary.prev_earned, 7 * 1.7, 1e-6);
assert.equal(r.summary.usage, 7 * 1.5e9);
near(r.summary.per_gb, (7 * 1.7) / 10.5, 1e-3);
near(r.summary.avg_per_day, 1.7);
assert.equal(r.summary.payouts, 10, 'tiền về trong kỳ tính theo ngày thanh toán');
near(r.summary.cost_vnd, 300000 * 7 / Number(new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate()), 1e4);
assert.equal(r.daily.length, 7);
const ra = r.accounts.find(x => x.id === A);
near(ra.earned, 7);
near(ra.share, 7 / 11.9, 1e-9);
near(ra.per_gb, 1, 1e-6);
assert.equal(ra.devices, 2);
near(ra.per_device_day, 0.5, 1e-6);
assert.equal(r.groups.length, 2);
assert.equal(r.months.length, 12);
assert.ok(r.months.at(-1).has_data);
assert.ok(r.countries.find(c => c.country === 'US').devices === 3);
assert.equal(r.devices[0].title, 'node-a1', 'máy kiếm nhiều nhất lên đầu');

// Báo cáo lọc theo acc: không tính chi phí chung
r = report({ from: addDays(today, -6), to: today, acc: String(B) });
near(r.summary.earned, 3.5);
assert.equal(r.summary.cost_vnd, null, 'lọc theo acc thì không phân bổ chi phí chung');
assert.equal(r.summary.payouts, 0);

// Khoảng ngày ngược / sai định dạng được xử lý
r = report({ from: today, to: addDays(today, -2) });
assert.equal(r.days, 3);
r = report({ from: 'abc' });
assert.equal(r.days, 30);

console.log('✅ Test báo cáo đều đạt');
