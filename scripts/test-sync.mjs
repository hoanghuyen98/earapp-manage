// Test logic đồng bộ & cảnh báo bằng dữ liệu giả (không gọi EarnApp thật)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-test-'));

const { db, getSettings, setSettings } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { EarnAppClient, AuthError, BannedError, RateLimitError } = await import('../server/earnapp.js');
const { syncAccount, runCycle, nextDelayMs, pickDue, spreadOverdue, requestSyncAll } = await import('../server/sync.js');
const { summary } = await import('../server/stats.js');
const { formatAlerts } = await import('../server/alerts.js');
const has = (list, type) => list.some(a => a.type === type);

let fake;
EarnAppClient.prototype.fetchAll = async () => { if (fake instanceof Error) throw fake; return structuredClone(fake); };

const dev = (uuid, extra = {}) => ({ uuid, title: uuid, rate: 10, earned: 0, earned_total: 0, country: 'us', ips: [], uptime: 0, total_uptime: 0, ...extra });
const base = (over = {}) => ({
  user: { email: 'a@test.com', joined_ts: '2026-09-30T00:00:00Z' },
  money: { balance: 1, earnings_total: 10 },
  devices: [dev('n1', { earned_total: 1 }), dev('n2', { earned_total: 2 })],
  statuses: { n1: [Date.now() - 6e5, 6e5], n2: [Date.now() - 6e5, 6e5] },
  transactions: [],
  usage: [{ _id: 'n1', data: { '2026-10-11': 5e6, '2026-10-12': 46.8e6 } }, { _id: 'n2', data: { '2026-10-11': 1e6, '2026-10-12': 3.2e6 } }],
  usageMonthly: [{ _id: 'n1', data: { '2026-09': 1e9, '2026-10': 2.5e9 } }],
  ...over,
});

db.prepare("INSERT INTO accounts(email, cookie_enc, created_at) VALUES ('a@test.com', ?, ?)").run(encrypt('oauth-refresh-token=x; auth=1'), Date.now());
const acc = () => db.prepare('SELECT * FROM accounts WHERE id = 1').get();
const devRow = u => db.prepare('SELECT * FROM devices WHERE uuid = ?').get(u);
setSettings({ offline_grace_min: 0 });
const s = () => getSettings();

// 1. Lần đầu: không cảnh báo, acc running
fake = base({ transactions: [{ uuid: 't0', status: 'paid', money_amount: 5, date: '2026-10-01' }] });
let alerts = await syncAccount(acc(), s());
assert.equal(alerts.length, 0, 'lần đầu không báo');
assert.equal(acc().status, 'running');
assert.equal(devRow('n1').status, 'online');

// 1b. Dung lượng: lưu theo ngày và theo tháng
const { usageSeries, usageMonthly, fmtBytes } = await import('../server/stats.js');
const ud = usageSeries(7, { accountId: 1 });
assert.equal(ud.at(-1).date, '2026-10-12');
assert.equal(ud.at(-1).value, 50e6, 'cộng dung lượng các máy trong ngày');
assert.equal(ud.at(-2).value, 6e6);
assert.equal(summary().usage_today, 50e6);
assert.equal(summary().usage_month, 2.5e9, 'tháng này lấy từ số liệu tháng của EarnApp');
assert.deepEqual(usageMonthly(2, { accountId: 1 }).map(x => x.value), [1e9, 2.5e9]);
assert.equal(fmtBytes(46.8e6), '46.8 MB');
assert.equal(fmtBytes(2.5e9), '2.50 GB');
// Ngày đã qua EarnApp cập nhật lại thì ghi đè, không cộng dồn
fake.usage[0].data['2026-10-11'] = 7e6;
await syncAccount(acc(), s());
assert.equal(usageSeries(7, { accountId: 1 }).at(-2).value, 8e6);
fake.usage[0].data['2026-10-11'] = 5e6;

// 2. n2 rớt mạng, n1 bị ban, lệnh rút mới, tiền tăng
await new Promise(r => setTimeout(r, 5));
fake = base({
  money: { balance: 1.5, earnings_total: 10.5 },
  devices: [dev('n1', { earned_total: 1.2, banned: { reason: 'ip_quality', ip: '1.2.3.4' } }), dev('n2', { earned_total: 2.3 })],
  statuses: { n1: [Date.now(), 1] },
  transactions: [{ uuid: 't0', status: 'paid', money_amount: 5, date: '2026-10-01' }, { uuid: 't1', status: 'pending_procedure', money_amount: 3, date: '2026-10-12', payment_method: 'paypal.com' }],
});
alerts = await syncAccount(acc(), s());
console.log(alerts);
assert.ok(has(alerts, 'device_banned'), 'báo máy bị ban');
assert.ok(has(alerts, 'device_offline'), 'báo rớt mạng');
assert.ok(has(alerts, 'payout_new'), 'báo lệnh rút');
assert.equal(devRow('n1').status, 'banned');
assert.equal(devRow('n2').status, 'offline');
assert.equal(acc().status, 'stopped', 'không còn máy chạy -> stopped');

// 3. Lặp lại: không báo trùng
alerts = await syncAccount(acc(), s());
assert.equal(alerts.filter(a => a.type !== 'payout_paid').length, 0, 'không báo lặp');

// 4. Lệnh rút được trả + n2 online lại
setSettings({ notify_online: true });
fake.transactions[1].status = 'paid';
fake.statuses.n2 = [Date.now(), 1];
alerts = await syncAccount(acc(), s());
console.log(alerts);
assert.ok(has(alerts, 'payout_paid'));
assert.ok(has(alerts, 'device_online'));
assert.equal(acc().status, 'running');

// 4b. Máy hết bị ban rồi bị ban lại: báo cả 2 lần
fake.devices[0] = dev('n1', { earned_total: 1.2 });
alerts = await syncAccount(acc(), s());
assert.ok(has(alerts, 'device_unbanned'), 'báo hết bị ban');
assert.equal(devRow('n1').alerted, '');
fake.devices[0] = dev('n1', { earned_total: 1.2, banned: { reason: 'earnapp_blacklist' } });
alerts = await syncAccount(acc(), s());
assert.ok(has(alerts, 'device_banned'), 'bị ban lại vẫn báo');

// 5. Online nhưng không ra tiền -> idle
db.prepare('UPDATE devices SET last_earn_at = ?, first_seen_at = ? WHERE uuid = ?').run(Date.now() - 5 * 3600e3, Date.now() - 5 * 3600e3, 'n2');
fake.statuses.n2 = [Date.now() - 5 * 3600e3, 5 * 3600e3];
alerts = await syncAccount(acc(), s());
assert.equal(devRow('n2').status, 'idle');
assert.ok(has(alerts, 'device_idle'));

// 6. Cookie hết hạn: báo 1 lần
fake = new AuthError('auth required');
alerts = await syncAccount(acc(), s());
assert.equal(alerts[0].type, 'auth');
assert.equal(acc().auth_state, 'expired');
assert.equal((await syncAccount(acc(), s())).length, 0);

// 7. Acc bị khoá -> banned, số dư tính vào "Đã ban"
fake = new BannedError('account suspended');
alerts = await syncAccount(acc(), s());
assert.equal(alerts[0].type, 'account_banned');
const t = summary();
console.log({ lifetime: t.lifetime, current: t.current, withdrawn: t.withdrawn, banned: t.banned, pending: t.pending, today: t.today });
assert.equal(t.banned, 1.5);
assert.equal(t.current, 0);
assert.equal(t.withdrawn, 8);
assert.equal(t.today, 0.5);

// ===== Phần mới: nghi bị khoá, giới hạn request, lưu số dư =====
db.prepare("INSERT INTO accounts(email, cookie_enc, created_at) VALUES ('b@test.com', ?, ?)").run(encrypt('oauth-refresh-token=y; auth=1'), Date.now());
const accB = () => db.prepare('SELECT * FROM accounts WHERE id = 2').get();
const okB = (over = {}) => base({ user: { email: 'b@test.com' }, money: { balance: 4, earnings_total: 20 }, devices: [dev('m1', { earned_total: 3 })], statuses: { m1: [Date.now(), 1] }, ...over });

// 8. Dữ liệu rỗng bất thường -> nghi bị khoá, GIỮ số dư cũ
fake = okB();
await syncAccount(accB(), s());
fake = okB({ money: { balance: 0, earnings_total: 0 }, devices: [], statuses: {} });
alerts = await syncAccount(accB(), s());
console.log(alerts);
assert.ok(has(alerts, 'account_suspect'), 'báo nghi bị khoá');
assert.ok(accB().suspect_reason.includes('máy biến mất'));
assert.equal(accB().balance, 4, 'giữ số dư cũ khi đang nghi');
assert.equal((await syncAccount(accB(), s())).length, 0, 'không báo lặp');
assert.equal(accB().balance, 4);

// 9. Bấm "không phải bị khoá" -> lần sau nhận số liệu mới, không báo lại
db.prepare("UPDATE accounts SET suspect_reason = '', suspect_ack = 1 WHERE id = 2").run();
alerts = await syncAccount(accB(), s());
assert.equal(alerts.length, 0);
assert.equal(accB().balance, 0, 'nhận số dư mới sau khi bỏ qua');
assert.equal(accB().suspect_ack, 0);

// 10. Nghi bị khoá rồi xác nhận Banned -> số dư cũ tính vào "Đã ban"
fake = okB();
await syncAccount(accB(), s());
fake = okB({ money: { balance: 0, earnings_total: 20 } });
alerts = await syncAccount(accB(), s());
assert.ok(alerts.some(a => a.type === 'account_suspect' && a.why.includes('số dư giảm')), 'số dư giảm không có lệnh rút');
db.prepare("UPDATE accounts SET status = 'banned', status_mode = 'manual', suspect_reason = '' WHERE id = 2").run();
await syncAccount(accB(), s());
assert.equal(accB().balance, 4, 'acc Banned giữ số dư lúc bị khoá');
assert.equal(summary().banned, 1.5 + 4);

// 11. Rút tiền thật (có lệnh rút mới) thì KHÔNG nghi
db.prepare("UPDATE accounts SET status = 'running', status_mode = 'auto' WHERE id = 2").run();
fake = okB({ money: { balance: 4, earnings_total: 20 } });
await syncAccount(accB(), s());
fake = okB({ money: { balance: 0.5, earnings_total: 20 }, transactions: [{ uuid: 'tb', status: 'pending_procedure', money_amount: 3.5, date: '2026-10-12' }] });
alerts = await syncAccount(accB(), s());
assert.ok(!has(alerts, 'account_suspect'), 'rút tiền không bị nghi');
assert.equal(accB().balance, 0.5);

// 12. Bị giới hạn request: chờ 5 -> 10 -> 20 phút, báo ở lần 3, thành công thì reset
fake = new RateLimitError('EarnApp giới hạn truy cập (HTTP 429)');
const waits = [];
for (let i = 0; i < 3; i++) {
  alerts = await syncAccount(accB(), s());
  waits.push(Math.round((accB().backoff_until - Date.now()) / 60e3));
  assert.equal(alerts.rateLimited, true);
}
console.log('thời gian chờ (phút):', waits);
assert.deepEqual(waits, [5, 10, 20]);
assert.ok(has(alerts, 'rate_limit'), 'báo ở lần thứ 3');
assert.equal(accB().auth_state, 'ok', 'bị giới hạn không phải lỗi cookie');

// 13. Vòng đồng bộ tự bỏ qua acc đang phải chờ
setSettings({ account_delay_sec: 1 });
const before = accB().last_sync_at;
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
await runCycle();
assert.equal(accB().last_sync_at, before, 'bỏ qua acc đang chờ');
db.prepare('UPDATE accounts SET backoff_until = ? WHERE id = 2').run(Date.now() - 1);
await runCycle([2]);
assert.equal(accB().backoff_level, 0, 'thành công thì reset');

// 14. Lưu số dư: mỗi giờ 1 bản + mỗi lần bất thường
const snaps = db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots WHERE account_id = 2').get().n;
console.log('số bản lưu số dư acc B:', snaps);
assert.ok(snaps >= 3 && snaps <= 5, 'không lưu mỗi 5 phút, chỉ lưu theo giờ + bất thường');

// 15. Lịch riêng từng acc: 5–10 phút ngẫu nhiên
setSettings({ sync_min_min: 5, sync_max_min: 10 });
const delays = Array.from({ length: 500 }, () => nextDelayMs(s()) / 60e3);
assert.ok(Math.min(...delays) >= 5 && Math.max(...delays) <= 10, 'luôn trong 5–10 phút');
assert.ok(Math.max(...delays) - Math.min(...delays) > 3, 'thật sự ngẫu nhiên');
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
const t0 = Date.now();
await runCycle([2]);
const gap = (accB().next_sync_at - t0) / 60e3;
console.log('acc B hẹn lần tới sau', gap.toFixed(1), 'phút');
assert.ok(gap >= 5 && gap <= 10.1, 'sau khi lấy xong hẹn lần tới trong 5–10 phút');

// 16. Chọn acc tới lượt: quá hạn lâu nhất trước, bỏ qua acc tạm ngừng / đang bị giới hạn
const now = Date.now();
db.prepare('UPDATE accounts SET next_sync_at = ?, backoff_until = NULL, paused = 0 WHERE id = 1').run(now - 1000);
db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = 2').run(now - 5000);
assert.equal(pickDue(now).id, 2, 'quá hạn lâu hơn được lấy trước');
db.prepare('UPDATE accounts SET paused = 1 WHERE id = 2').run();
assert.equal(pickDue(now).id, 1, 'bỏ qua acc tạm ngừng');
db.prepare('UPDATE accounts SET paused = 0, backoff_until = ? WHERE id = 2').run(now + 60e3);
assert.equal(pickDue(now).id, 1, 'bỏ qua acc đang bị giới hạn');
db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = 1').run(now + 60e3);
assert.equal(pickDue(now), null, 'chưa tới giờ thì không lấy');

// 17. Khởi động lại sau khi tắt lâu: acc quá hạn được rải ra, không gọi dồn
for (let i = 0; i < 20; i++) db.prepare("INSERT INTO accounts(email, cookie_enc, created_at, next_sync_at) VALUES (?, 'x', ?, ?)").run(`z${i}@t.com`, now, now - 3600e3);
const n = spreadOverdue(now, s());
const times = db.prepare("SELECT next_sync_at t FROM accounts WHERE email LIKE 'z%'").all().map(r => (r.t - now) / 60e3);
console.log(`rải ${n} acc quá hạn trong`, Math.min(...times).toFixed(1), '→', Math.max(...times).toFixed(1), 'phút');
assert.ok(times.every(t => t >= 0 && t <= 5), 'rải trong 5 phút đầu');
assert.ok(Math.max(...times) - Math.min(...times) > 2, 'không dồn cùng 1 lúc');

// 18. Nút "Đồng bộ ngay": xếp hàng cách nhau đúng khoảng nghỉ
setSettings({ account_delay_sec: 3 });
requestSyncAll(s());
const q = db.prepare('SELECT next_sync_at t FROM accounts WHERE paused = 0 AND (backoff_until IS NULL OR backoff_until <= ?) ORDER BY id').all(Date.now()).map(r => r.t);
assert.ok(q.slice(1).every((t, i) => Math.abs(t - q[i] - 3000) < 50), 'cách nhau 3 giây');

// 19. Soạn tin Telegram: gom theo acc, có tên + email, giải thích rõ
const sample = [
  { type: 'device_unbanned', account_id: 1, label: 'Acc VPS 1', email: 'a@gmail.com', device: 'sdk-node-1' },
  { type: 'device_unbanned', account_id: 1, label: 'Acc VPS 1', email: 'a@gmail.com', device: 'sdk-node-2' },
  { type: 'device_offline', account_id: 2, label: null, email: 'b@gmail.com', device: 'sdk-win-9', last_seen: Date.now() - 20 * 60e3 },
  { type: 'device_banned', account_id: 1, label: 'Acc VPS 1', email: 'a@gmail.com', device: 'sdk-node-3', reason: 'ip_quality' },
];
const msg = formatAlerts(sample, { ...s(), usd_vnd: 26000 });
console.log('----- Mẫu tin Telegram -----\n' + msg.replace(/<\/?b>/g, '') + '\n----------------------------');
assert.ok(msg.includes('Acc VPS 1') && msg.includes('a@gmail.com') && msg.includes('b@gmail.com'), 'có tên và email');
assert.equal(msg.split('👤').length - 1, 2, 'gom theo 2 tài khoản');
assert.ok(msg.indexOf('BAN</b>') < msg.indexOf('GỠ BAN'), 'việc nghiêm trọng lên trước');
assert.ok(msg.includes('IP bị đánh giá chất lượng kém'), 'lý do ban bằng tiếng Việt');

// 20. Trạng thái luôn tự động: acc ở chế độ tay cũ vẫn được cập nhật theo máy
db.prepare("UPDATE accounts SET status = 'running', status_mode = 'manual', backoff_until = NULL, paused = 0 WHERE id = 2").run();
fake = okB({ money: { balance: 0.5, earnings_total: 20 }, statuses: {} });
await runCycle([2]);
await runCycle([2]); // rỗng 2 lần liên tiếp mới tính là rớt thật
assert.equal(accB().status, 'stopped', 'không còn máy online -> Stopped dù trước đó chỉnh tay');
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
await runCycle([2]);
assert.equal(accB().status, 'running', 'có máy online lại -> Running');

// 21. EarnApp trả trạng thái rỗng 1 lần (lỗi thoáng qua): giữ nguyên, không báo rớt
setSettings({ offline_grace_min: 0 });
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
await runCycle([2]);
assert.equal(db.prepare("SELECT status FROM devices WHERE uuid = 'm1'").get().status, 'online');
fake = okB({ money: { balance: 0.5, earnings_total: 20 }, statuses: {} });
alerts = await syncAccount(accB(), s());
assert.equal(db.prepare("SELECT status FROM devices WHERE uuid = 'm1'").get().status, 'online', 'rỗng 1 lần: giữ online');
assert.ok(!has(alerts, 'device_offline'), 'không báo rớt giả');
assert.equal(accB().status, 'running');
// Rỗng lần 2 liên tiếp: tin là rớt thật
alerts = await syncAccount(accB(), s());
assert.equal(db.prepare("SELECT status FROM devices WHERE uuid = 'm1'").get().status, 'offline', 'rỗng 2 lần: offline thật');
assert.ok(has(alerts, 'device_offline'));
// Có dữ liệu lại thì reset bộ đếm
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
await syncAccount(accB(), s());
assert.equal(accB().empty_status_streak, 0);

console.log('✅ Tất cả test đều đạt');
