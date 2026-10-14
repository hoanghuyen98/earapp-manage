// Test hẹn giờ rút tiền bằng EarnApp giả (không gọi EarnApp thật, không gửi Telegram)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-test-'));

const { db, setSettings } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { EarnAppClient, NetworkError } = await import('../server/earnapp.js');
const { alertQueue } = await import('../server/sync.js');
const { zonedTs, nextRunAt, validateSchedule, saveSchedule, runWithdraw, checkDueWithdrawals } = await import('../server/withdraw.js');
const { formatAlerts } = await import('../server/alerts.js');

setSettings({ timezone: 'Asia/Ho_Chi_Minh', telegram_token: '' });
// Ghi lại cảnh báo (không có Telegram nên hàng chờ bị xả ngay)
const sent = [];
const push = alertQueue.push.bind(alertQueue);
alertQueue.push = (...a) => { sent.push(...a); return push(...a); };
const TZ = 'Asia/Ho_Chi_Minh';

// ---- Giờ theo múi giờ ----
assert.equal(new Date(zonedTs('2026-10-14', '10:00', TZ)).toISOString(), '2026-10-14T03:00:00.000Z', '10h VN = 3h UTC');
assert.equal(new Date(zonedTs('2026-03-08', '10:00', 'America/New_York')).toISOString(), '2026-03-08T14:00:00.000Z', 'ngày đổi giờ mùa hè');

// 14/10/2026 là thứ 4. Đang 9h sáng thứ 4:
const wed9 = zonedTs('2026-10-14', '09:00', TZ);
assert.equal(nextRunAt({ mode: 'weekly', weekdays: '3', time: '10:00' }, wed9, TZ), zonedTs('2026-10-14', '10:00', TZ), 'T4 10h: chạy ngay hôm nay');
assert.equal(nextRunAt({ mode: 'weekly', weekdays: '3', time: '08:00' }, wed9, TZ), zonedTs('2026-10-21', '08:00', TZ), 'đã qua giờ -> tuần sau');
assert.equal(nextRunAt({ mode: 'weekly', weekdays: '4', time: '15:00' }, wed9, TZ), zonedTs('2026-10-15', '15:00', TZ), 'T5 15h');
assert.equal(nextRunAt({ mode: 'weekly', weekdays: '1,4', time: '15:00' }, zonedTs('2026-10-16', '09:00', TZ), TZ), zonedTs('2026-10-19', '15:00', TZ), 'nhiều thứ: lấy thứ gần nhất');
assert.equal(nextRunAt({ mode: 'once', run_date: '2026-10-14', time: '10:00' }, wed9, TZ), zonedTs('2026-10-14', '10:00', TZ));
assert.equal(nextRunAt({ mode: 'once', run_date: '2026-10-14', time: '08:00' }, wed9, TZ), null);

// ---- Kiểm tra dữ liệu nhập ----
const base = { mode: 'weekly', weekdays: [3], time: '10:00', method: 'paypal.com', email: 'me@paypal.com' };
assert.throws(() => validateSchedule({ ...base, time: '25:00' }, wed9, TZ), /Giờ rút/);
assert.throws(() => validateSchedule({ ...base, email: 'abc' }, wed9, TZ), /Email/);
assert.throws(() => validateSchedule({ ...base, method: 'x' }, wed9, TZ), /phương thức/);
assert.throws(() => validateSchedule({ ...base, weekdays: [] }, wed9, TZ), /thứ/);
assert.throws(() => validateSchedule({ ...base, mode: 'once', run_date: '2026-10-14', time: '08:00' }, wed9, TZ), /đã qua/);
assert.equal(validateSchedule({ ...base, weekdays: [4, 1, 4] }, wed9, TZ).weekdays, '1,4');

// ---- Chạy lệnh rút với EarnApp giả ----
let fake, calls = [];
EarnAppClient.prototype.call = async function (name, opts = {}) {
  calls.push({ name, body: opts.body });
  if (fake.error && name === fake.errorOn) throw fake.error;
  if (name === 'money') return { balance: fake.balance };
  if (name === 'payment_methods') return { 'paypal.com': { min_redeem: 10 }, 'wise.com': { min_redeem: 10, disabled: fake.wiseOff } };
  if (name === 'redeem') return fake.redeem ?? { status: 'ok' };
  throw new Error('không mong đợi ' + name);
};

for (const email of ['a@test.com', 'b@test.com']) {
  db.prepare('INSERT INTO accounts(email, cookie_enc, created_at) VALUES (?, ?, ?)').run(email, encrypt('oauth-refresh-token=x; auth=1'), Date.now());
}
const sch = id => db.prepare('SELECT * FROM withdraw_schedules WHERE account_id = ?').get(id);
const logs = () => db.prepare('SELECT * FROM withdraw_log ORDER BY id').all();

// Acc 1: rút 1 lần, Acc 2: hằng tuần T5 15h
const future = new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
saveSchedule(1, { mode: 'once', run_date: future, time: '10:00', method: 'paypal.com', email: 'pay1@test.com' });
saveSchedule(2, { mode: 'weekly', weekdays: [4], time: '15:00', method: 'wise.com', email: 'pay2@test.com' });
assert.equal(sch(1).next_run_at, zonedTs(future, '10:00', TZ));

// Chưa tới giờ: không làm gì
await checkDueWithdrawals();
assert.equal(calls.length, 0);

// Tới giờ, số dư đủ: gửi đúng email + phương thức, lịch 1 lần tự tắt
fake = { balance: 12.5 };
db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = 1').run(Date.now() - 1000);
await checkDueWithdrawals();
const redeemCall = calls.find(c => c.name === 'redeem');
assert.deepEqual(redeemCall.body, { to: 'pay1@test.com', payment_method: 'paypal.com' });
assert.equal(sch(1).enabled, 0, 'rút 1 lần xong thì tắt');
assert.equal(sch(1).next_run_at, null);
assert.equal(sch(1).last_status, 'ok');
assert.equal(logs().at(-1).amount, 12.5);
assert.ok(sent.some(a => a.type === 'withdraw_ok' && a.amount === 12.5));

// Không chạy lại lần 2
calls = [];
await checkDueWithdrawals();
assert.equal(calls.length, 0, 'không rút trùng');

// Acc 2 hằng tuần: số dư thiếu -> bỏ qua, hẹn tuần sau, KHÔNG gọi redeem
fake = { balance: 4 };
db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = 2').run(Date.now() - 1000);
await checkDueWithdrawals();
assert.ok(!calls.some(c => c.name === 'redeem'), 'thiếu tiền thì không gọi redeem');
assert.equal(sch(2).last_status, 'skipped');
assert.equal(sch(2).enabled, 1);
assert.ok(sch(2).next_run_at > Date.now(), 'hẹn lần sau');
assert.equal(new Date(sch(2).next_run_at).getUTCHours(), 8, '15h VN');

// EarnApp từ chối -> failed
fake = { balance: 20, redeem: { error: 'Payment details are invalid' } };
db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = 2').run(Date.now() - 1000);
await checkDueWithdrawals();
assert.equal(sch(2).last_status, 'failed');
assert.match(sch(2).last_message, /Payment details are invalid/);

// Phương thức bị EarnApp tắt
fake = { balance: 20, wiseOff: true };
calls = [];
db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = 2').run(Date.now() - 1000);
await checkDueWithdrawals();
assert.ok(!calls.some(c => c.name === 'redeem'));
assert.equal(sch(2).last_status, 'failed');

// Lỗi mạng: thử lại sau 10 phút, tối đa 3 lần rồi báo lỗi
fake = { balance: 20, error: new NetworkError('proxy chết'), errorOn: 'money' };
for (let i = 1; i <= 3; i++) {
  db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = 2').run(Date.now() - 1000);
  await checkDueWithdrawals();
  if (i < 3) {
    assert.equal(sch(2).last_status, 'retry');
    assert.ok(Math.abs(sch(2).next_run_at - Date.now() - 600e3) < 5000, 'thử lại sau 10 phút');
  }
}
assert.equal(sch(2).last_status, 'failed');
assert.equal(sch(2).attempts, 0);

// Server tắt quá 24h: bỏ qua, không rút vào giờ bất kỳ
fake = { balance: 20 };
calls = [];
db.prepare('UPDATE withdraw_schedules SET next_run_at = ? WHERE account_id = 2').run(Date.now() - 2 * 864e5);
await checkDueWithdrawals();
assert.equal(calls.length, 0);
assert.equal(sch(2).last_status, 'missed');
assert.ok(sch(2).next_run_at > Date.now());

// Rút ngay bằng tay: không đổi giờ hẹn
const before = sch(2).next_run_at;
const r = await runWithdraw(2, { manual: true });
assert.equal(r.status, 'ok');
assert.equal(sch(2).next_run_at, before);

// Acc bị khoá: không rút
db.prepare("UPDATE accounts SET status = 'banned' WHERE id = 2").run();
assert.equal((await runWithdraw(2, { manual: true })).status, 'failed');

// Tin Telegram
const msg = formatAlerts(sent.filter(a => a.type.startsWith('withdraw_')), { timezone: TZ, usd_vnd: 26000 });
assert.match(msg, /Đã tạo lệnh rút<\/b>: \$12\.50/);
assert.match(msg, /Chưa rút được/);
assert.match(msg, /THẤT BẠI/);

console.log('✓ test-withdraw: tất cả đều đúng');
process.exit(0);
