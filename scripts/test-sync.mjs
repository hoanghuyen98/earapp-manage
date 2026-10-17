// Test logic đồng bộ & cảnh báo bằng dữ liệu giả (không gọi EarnApp thật)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-test-'));

const { db, getSettings, setSettings } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { EarnAppClient, AuthError, BannedError, RateLimitError } = await import('../server/earnapp.js');
const { syncAccount, runCycle, nextDelayMs, pickDue, spreadOverdue, requestSyncAll, markStale, getProgress, maxParallel } = await import('../server/sync.js');
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
// 5a. Cả acc không máy nào tăng tiền (EarnApp chưa cập nhật / acc kiếm quá ít): KHÔNG báo nhầm sau vài giờ
setSettings({ idle_hours: 3 });
db.prepare('UPDATE devices SET last_earn_at = ? WHERE account_id = 1').run(Date.now() - 5 * 3600e3);
db.prepare('UPDATE devices SET last_earn_at = ?, first_seen_at = ? WHERE uuid = ?').run(Date.now() - 5 * 3600e3, Date.now() - 5 * 3600e3, 'n2');
fake.statuses.n2 = [Date.now() - 5 * 3600e3, 5 * 3600e3];
alerts = await syncAccount(acc(), s());
assert.equal(devRow('n2').status, 'online', 'cả acc đứng yên 5h: chưa coi là không ra tiền');
assert.ok(!has(alerts, 'device_idle'));
// ...nhưng đứng yên quá 24h thì vẫn báo
db.prepare('UPDATE devices SET last_earn_at = ? WHERE account_id = 1').run(Date.now() - 25 * 3600e3);
db.prepare('UPDATE devices SET last_earn_at = ?, first_seen_at = ? WHERE uuid = ?').run(Date.now() - 25 * 3600e3, Date.now() - 25 * 3600e3, 'n2');
fake.statuses.n2 = [Date.now() - 25 * 3600e3, 25 * 3600e3];
alerts = await syncAccount(acc(), s());
assert.equal(devRow('n2').status, 'idle', 'đứng yên quá 24h thì báo');
assert.ok(has(alerts, 'device_idle'));
// 5b. Máy khác cùng acc vẫn tăng tiền mà máy này 5h không tăng: báo ngay theo idle_hours
fake.devices.push(dev('n3', { earned_total: 0.5 }));
fake.statuses.n3 = [Date.now() - 6e5, 6e5];
await syncAccount(acc(), s());
db.prepare("UPDATE devices SET status = 'online', alerted = '' WHERE uuid = 'n2'").run();
db.prepare('UPDATE devices SET last_earn_at = ?, first_seen_at = ? WHERE uuid = ?').run(Date.now() - 5 * 3600e3, Date.now() - 5 * 3600e3, 'n2');
fake.statuses.n2 = [Date.now() - 5 * 3600e3, 5 * 3600e3];
fake.devices[2] = dev('n3', { earned_total: 0.6 }); // n3 vừa tăng tiền
alerts = await syncAccount(acc(), s());
assert.equal(devRow('n2').status, 'idle', 'máy khác vẫn ra tiền: báo sau idle_hours');
assert.ok(has(alerts, 'device_idle'));
assert.equal(devRow('n3').status, 'online');
// 5c. Máy đang báo "không ra tiền" chuyển về online mà CHƯA tăng tiền (VD đổi ngưỡng): không báo "chạy lại"
setSettings({ idle_hours: 12 });
alerts = await syncAccount(acc(), s());
assert.ok(!has(alerts, 'device_online'), 'chưa tăng tiền thì không báo chạy lại');
assert.equal(devRow('n2').alerted, 'idle', 'vẫn nhớ đã báo, không báo lặp khi idle lại');
// ...tăng tiền thật thì báo chạy lại
fake.devices[1] = dev('n2', { earned_total: (devRow('n2').earned_total || 0) + 0.01 });
alerts = await syncAccount(acc(), s());
assert.ok(has(alerts, 'device_online'), 'ra tiền lại thì báo');
setSettings({ idle_hours: 3 });
fake.devices.pop(); delete fake.statuses.n3;

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
assert.ok(accB().suspect_reason.includes('node biến mất'));
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

// 16b. Vừa thêm acc (chưa có giờ hẹn) + đồng bộ ngay: lịch tự động không lấy trùng
db.prepare('UPDATE accounts SET next_sync_at = NULL, backoff_until = NULL WHERE id = 2').run();
assert.equal(pickDue()?.id, 2, 'acc mới tới lượt ngay');
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
const syncing = runCycle([2]);
assert.equal(pickDue(), null, 'đang đồng bộ riêng thì lịch tự động bỏ qua');
const steps = [];
EarnAppClient.prototype.fetchAll = async ({ onStep }) => {
  if (fake instanceof Error) throw fake;
  for (const [f, l] of [[0, 'a'], [0.5, 'b'], [1, 'c']]) { onStep(f, l); steps.push(getProgress([2])[0].percent); }
  return structuredClone(fake);
};
assert.equal(getProgress([2])[0].state, 'queued', 'vừa thêm: đang chờ tới lượt');
assert.ok(getProgress([2])[0].eta_sec > 0, 'có ước tính thời gian');
await syncing;
assert.deepEqual(steps, [0, 48, 95], 'phần trăm tăng dần theo từng bước, chừa 5% cho bước lưu');
assert.equal(getProgress([2])[0].state, 'done', 'xong thì báo đã tải xong');
assert.equal(getProgress([2])[0].percent, 100);
fake = new Error('proxy chết');
await runCycle([2]);
assert.equal(getProgress([2])[0].state, 'error', 'lỗi thì báo lỗi');
assert.match(getProgress([2])[0].error, /proxy chết/);
EarnAppClient.prototype.fetchAll = async () => { if (fake instanceof Error) throw fake; return structuredClone(fake); };
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
await runCycle([2]);
assert.ok(accB().next_sync_at > Date.now() + 4 * 60e3, 'xong thì hẹn lần tới bình thường');

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
assert.ok(msg.includes('<b>Acc VPS 1 (a@gmail.com)</b>') && msg.includes('<b>b@gmail.com</b>'), 'có tên riêng thì kèm email, không có thì chỉ email');
assert.equal(msg.split('👤').length - 1, 2, 'gom theo 2 tài khoản');
assert.ok(msg.indexOf('bị BAN') < msg.indexOf('gỡ ban'), 'việc nghiêm trọng lên trước');
assert.ok(msg.includes('IP chất lượng kém'), 'lý do ban bằng tiếng Việt');
// Nhiều acc cùng lỗi: gộp 1 mục, lỗi 404 giải thích dễ hiểu, ghi số liệu dừng từ lúc nào
const many = ['x1@gmail.com', 'x2@gmail.com', 'x3@gmail.com'].map((email, i) => ({ type: 'sync_error', account_id: 100 + i, email,
  why: 'EarnApp user_data lỗi 404: Not found', count: 3, since: Date.now() - 3 * 3600e3 }));
const mergedMsg = formatAlerts(many, s());
console.log('----- Mẫu tin gộp -----\n' + mergedMsg.replace(/<\/?b>/g, '') + '\n-----------------------');
assert.equal(mergedMsg.split('👤').length - 1, 0, 'không tách từng acc');
assert.ok(mergedMsg.includes('3 acc không lấy được dữ liệu mới') && mergedMsg.includes('x3@gmail.com'));
assert.ok(mergedMsg.includes('bảo trì') && mergedMsg.includes('đang dừng từ'));
// 2 acc thì vẫn tách riêng
assert.equal(formatAlerts(many.slice(0, 2), s()).split('👤').length - 1, 2);

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

// 22. Lỗi lấy dữ liệu liên tiếp (proxy chết…): báo đúng 1 lần khi đủ ngưỡng, báo khi hết lỗi
const { NetworkError, normalizeProxy } = await import('../server/earnapp.js');
setSettings({ error_alert_count: 3, notify_sync_error: true });
fake = new NetworkError('Không kết nối được EarnApp qua proxy: bị từ chối kết nối (ECONNREFUSED)');
const errAlerts = [];
for (let i = 0; i < 5; i++) errAlerts.push(...await syncAccount(accB(), s()));
assert.equal(accB().error_streak, 5);
assert.equal(accB().auth_state, 'error');
assert.equal(errAlerts.filter(a => a.type === 'sync_error').length, 1, 'chỉ báo 1 lần ở lần lỗi thứ 3');
assert.ok(formatAlerts(errAlerts, s()).includes('ECONNREFUSED'));
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
alerts = await syncAccount(accB(), s());
assert.ok(has(alerts, 'sync_ok'), 'báo lấy được dữ liệu trở lại');
assert.equal(accB().error_streak, 0);
// Lỗi 1-2 lần rồi hết: không báo gì
fake = new Error('EarnApp money lỗi 500');
assert.equal((await syncAccount(accB(), s())).length, 0);
fake = okB({ money: { balance: 0.5, earnings_total: 20 } });
assert.ok(!has(await syncAccount(accB(), s()), 'sync_ok'), 'chưa từng báo lỗi thì không báo hết lỗi');

// 23. Proxy: http, socks5, dạng host:port:user:pass
assert.equal(normalizeProxy(''), '');
assert.equal(normalizeProxy('1.2.3.4:8080'), 'http://1.2.3.4:8080');
assert.equal(normalizeProxy('1.2.3.4:8080:user:p@ss'), 'http://user:p%40ss@1.2.3.4:8080');
assert.equal(normalizeProxy('socks5://1.2.3.4:1080:user:pass'), 'socks5://user:pass@1.2.3.4:1080');
assert.equal(normalizeProxy('socks5h://u:p@host.com:1080'), 'socks5://u:p@host.com:1080');
assert.throws(() => normalizeProxy('ftp://1.2.3.4:21'), /chỉ hỗ trợ/);

// 24. Telegram lỗi: cảnh báo không mất, lần sau gửi lại (giả lập Telegram, không gửi tin thật)
const { flushAlerts, alertQueue } = await import('../server/sync.js');
setSettings({ telegram_token: 'fake', telegram_chat_id: '1' });
const realFetch = globalThis.fetch;
const sent = [];
let tgDown = true;
globalThis.fetch = async (url, o) => {
  if (tgDown) throw new TypeError('fetch failed');
  sent.push(JSON.parse(o.body).text);
  return new Response('{"ok":true}');
};
alertQueue.push({ type: 'device_offline', ts: Date.now() - 20 * 60e3, account_id: 1, email: 'a@test.com', device: 'n1' });
await flushAlerts(s());
assert.equal(alertQueue.length, 1, 'gửi lỗi: giữ lại trong hàng chờ');
alertQueue.push({ type: 'device_banned', ts: Date.now(), account_id: 1, email: 'a@test.com', device: 'n2', reason: 'ip_quality' });
tgDown = false;
await flushAlerts(s());
assert.equal(alertQueue.length, 0);
assert.equal(sent.length, 1, 'gửi gộp 1 tin');
assert.ok(sent[0].includes('n1') && sent[0].includes('n2') && sent[0].includes('Gửi trễ'), 'có cả cảnh báo cũ, ghi rõ gửi trễ');
// Hàng chờ không phình vô hạn khi Telegram lỗi lâu
tgDown = true;
for (let i = 0; i < 600; i++) alertQueue.push({ type: 'device_offline', ts: Date.now(), account_id: 1, device: 'x' + i });
await flushAlerts(s());
assert.equal(alertQueue.length, 500);
assert.equal(alertQueue.at(-1).device, 'x599', 'giữ cảnh báo mới nhất');
alertQueue.length = 0;
globalThis.fetch = realFetch;
setSettings({ telegram_token: '', telegram_chat_id: '' });

// Dữ liệu cũ: lâu không lấy được dữ liệu mới thì máy chuyển "Chưa rõ", lấy lại được thì về trạng thái thật
{
  db.prepare("INSERT INTO accounts(email, cookie_enc, created_at) VALUES ('stale@test.com', ?, ?)").run(encrypt('oauth-refresh-token=x'), Date.now());
  const sid = db.prepare("SELECT id FROM accounts WHERE email = 'stale@test.com'").get().id;
  const sacc = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(sid);
  fake = base({ user: { email: 'stale@test.com' }, devices: [dev('s1', { earned_total: 1 })], statuses: { s1: [Date.now() - 6e5, 6e5] }, usage: [], usageMonthly: null });
  await syncAccount(sacc(), s());
  assert.equal(devRow('s1').status, 'online');
  assert.ok(sacc().last_ok_at > 0, 'ghi lần thành công');
  markStale();
  assert.equal(devRow('s1').status, 'online', 'vừa lấy xong: chưa cũ');
  db.prepare('UPDATE accounts SET last_ok_at = ? WHERE id = ?').run(Date.now() - 31 * 60e3, sid);
  markStale();
  assert.equal(devRow('s1').status, 'unknown', 'quá 30 phút: chưa rõ');
  const staleBefore = summary().accounts.stale;
  assert.ok(staleBefore >= 1 && summary().devices.unknown >= 1, 'tổng quan đếm máy chưa rõ');
  // Lỗi lấy dữ liệu: vẫn chưa rõ, không bị đếm là online
  fake = new Error('EarnApp user_data lỗi 404: Not found');
  await syncAccount(sacc(), s());
  markStale();
  assert.equal(devRow('s1').status, 'unknown');
  // Lấy lại được: về trạng thái thật
  fake = base({ user: { email: 'stale@test.com' }, devices: [dev('s1', { earned_total: 1.1 })], statuses: { s1: [Date.now() - 6e5, 6e5] }, usage: [], usageMonthly: null });
  await syncAccount(sacc(), s());
  assert.equal(devRow('s1').status, 'online');
  assert.equal(summary().accounts.stale, staleBefore - 1, 'hết bị coi là dữ liệu cũ');
}

// Chạy song song: acc khác proxy chạy cùng lúc (tối đa max_parallel trong Cài đặt), cùng proxy / không proxy thì lần lượt,
// acc đang xếp hàng thì lịch tự động không lấy trùng
{
  assert.equal(maxParallel(), 10, 'mặc định 10 acc cùng lúc');
  assert.equal(maxParallel({ max_parallel: 99 }), 20, 'tối đa 20');
  assert.equal(maxParallel({ max_parallel: 0 }), 1, 'ít nhất 1');
  setSettings({ account_delay_sec: 0, max_parallel: 4 });
  const mk = (email, proxy) => Number(db.prepare('INSERT INTO accounts(email, cookie_enc, proxy, created_at) VALUES (?, ?, ?, ?)')
    .run(email, encrypt('oauth-refresh-token=x'), proxy, Date.now()).lastInsertRowid);
  const ids = [
    ...[1, 2, 3, 4, 5, 6].map(i => mk(`p${i}@test.com`, `socks5://10.0.0.${i}:1080`)),
    mk('same1@test.com', 'socks5://10.0.0.9:1080'), mk('same2@test.com', 'socks5://10.0.0.9:1080'),
    mk('direct1@test.com', ''), mk('direct2@test.com', ''),
  ];
  const savedFetch = EarnAppClient.prototype.fetchAll;
  let now = 0, peak = 0, overlapSameRoute = false, t0 = Date.now();
  const starts = [];
  const routeNow = new Map();
  EarnAppClient.prototype.fetchAll = async function () {
    const key = this.dispatcher ? [...routeNow.keys()].find(k => k === this.dispatcher) ?? this.dispatcher : 'direct';
    if (routeNow.get(key)) overlapSameRoute = true;
    routeNow.set(key, 1);
    now++; peak = Math.max(peak, now); starts.push(Date.now() - t0);
    await new Promise(r => setTimeout(r, 150));
    now--; routeNow.delete(key);
    return { ...base(), user: { email: 'x@test.com' }, devices: [], statuses: {}, usage: [], usageMonthly: null };
  };
  t0 = Date.now();
  const run = runCycle(ids);
  assert.ok(ids.every(id => !pickDue() || pickDue().id !== id), 'acc đang xếp hàng: lịch tự động không lấy trùng');
  await run;
  const took = Date.now() - t0;
  console.log('bắt đầu lúc (ms):', starts.join(', '));
  console.log(`10 acc (6 proxy riêng, 2 chung proxy, 2 không proxy): chạy cùng lúc tối đa ${peak}, mất ${took}ms`);
  assert.equal(peak, 4, 'chạy song song đúng số trong Cài đặt');
  assert.ok(!overlapSameRoute, 'cùng 1 proxy (hoặc cùng IP server) không bao giờ chạy chồng');
  // 8 acc có proxy (7 đường ra) xong trong ~3 lượt thay vì 8 lượt nối nhau; 2 acc không proxy vẫn chờ nhau
  assert.ok(starts.slice(0, 8).every(t => t < 2000), '8 acc có proxy đều được chạy ngay, không xếp hàng nối đuôi');
  assert.ok(starts[9] - starts[8] >= 150, 'acc không proxy chạy lần lượt (cùng IP server)');
  assert.ok(ids.every(id => getProgress([id])[0].state === 'done'), 'acc nào cũng xong');
  EarnAppClient.prototype.fetchAll = savedFetch;
}

console.log('✅ Tất cả test đều đạt');
