// Test gửi tin Telegram bằng máy chủ Telegram giả (không gửi tin thật).
// Chạy với PREVIEW=1 để in nội dung các tin ra màn hình.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eam-test-'));

const { db, setSettings, getSettings } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { sendTelegram, sendTelegramEach, chatIds, validChatId, explainTelegram, esc } = await import('../server/telegram.js');
const { formatAlerts } = await import('../server/alerts.js');
const { formatDailyReport } = await import('../server/dailyReport.js');
const preview = (title, text) => process.env.PREVIEW && console.log(`\n===== ${title} =====\n${text}`);

// ---- Máy chủ Telegram giả ----
let calls = [], reply = () => new Response('{"ok":true}');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, o) => {
  calls.push({ url, body: JSON.parse(o.body) });
  return reply();
};

/** Kiểm tra HTML theo luật Telegram: chỉ thẻ được phép, đóng mở khớp, & < > phải là entity */
const ALLOWED = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler'];
function checkHtml(text, label) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z-]+)(?:\s[^<>]*)?>|<|>|&(?!(?:lt|gt|amp|quot|#\d+);)/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) assert.fail(`${label}: ký tự "${m[0]}" chưa escape ở vị trí ${m.index}: …${text.slice(m.index - 30, m.index + 30)}…`);
    const tag = m[2].toLowerCase();
    assert.ok(ALLOWED.includes(tag), `${label}: Telegram không hỗ trợ thẻ <${tag}>`);
    if (m[1]) assert.equal(stack.pop(), tag, `${label}: thẻ </${tag}> đóng sai`);
    else stack.push(tag);
  }
  assert.equal(stack.length, 0, `${label}: thẻ chưa đóng: ${stack.join(', ')}`);
}

// 1. Chưa cài token / chat id: không gửi
setSettings({ telegram_token: '', telegram_chat_id: '' });
assert.equal(await sendTelegram('hi'), false);
assert.equal(calls.length, 0);

// 2. Gửi đúng API, đúng chat, parse HTML, tắt xem trước link
const s = { ...getSettings(), telegram_token: '123:ABC', telegram_chat_id: '-100999', timezone: 'Asia/Ho_Chi_Minh', usd_vnd: 26000, offline_grace_min: 10, idle_hours: 3 };
assert.equal(await sendTelegram('<b>Xin chào</b>', s), true);
assert.equal(calls[0].url, 'https://api.telegram.org/bot123:ABC/sendMessage');
assert.deepEqual(calls[0].body, { chat_id: '-100999', text: '<b>Xin chào</b>\n', parse_mode: 'HTML', disable_web_page_preview: true });

// 3. Tin dài: cắt thành nhiều tin < 4096 ký tự, không cắt giữa dòng, không mất dòng nào
calls = [];
const lines = Array.from({ length: 400 }, (_, i) => `• <b>Dòng ${i}</b> ` + 'x'.repeat(20));
await sendTelegram(lines.join('\n'), s);
assert.ok(calls.length > 1, 'tin dài phải cắt');
for (const c of calls) {
  assert.ok(c.body.text.length <= 4096, 'mỗi phần ≤ 4096 ký tự');
  assert.ok(c.body.text.trim().length > 0, 'không gửi phần rỗng');
  checkHtml(c.body.text, 'phần tin dài');
}
assert.deepEqual(calls.flatMap(c => c.body.text.trimEnd().split('\n')), lines, 'đủ mọi dòng, đúng thứ tự');

// 3b. Một dòng dài hơn giới hạn (hiếm): cắt bớt dòng đó, không gửi phần rỗng hay phần quá dài
calls = [];
await sendTelegram('<b>Tiêu đề</b>\n<b>' + 'y&amp;'.repeat(2000) + '</b>\ncuối', s);
for (const c of calls) {
  assert.ok(c.body.text.length <= 4096 && c.body.text.trim().length > 0);
  checkHtml(c.body.text, 'dòng quá dài');
}
assert.ok(calls.at(-1).body.text.includes('cuối'), 'các dòng sau vẫn được gửi');

// 4. Telegram trả lỗi (VD: sai chat id): báo lỗi rõ ràng để hàng chờ gửi lại
reply = () => new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 });
await assert.rejects(sendTelegram('x', s), /không tìm thấy chat/);
reply = () => new Response('{"ok":true}');

// 4b. Nhiều nơi nhận (nhóm + chat riêng)
assert.deepEqual(chatIds(' -1001234567890, 5880574224;5880574224 \n@kenh_abc '), ['-1001234567890', '5880574224', '@kenh_abc'], 'tách và bỏ trùng');
assert.ok(validChatId('-1001234567890') && validChatId('5880574224') && validChatId('@kenh_abc'));
assert.ok(!validChatId('abc') && !validChatId('-') && !validChatId('12'));
const multi = { ...s, telegram_chat_id: '-1001, 2002, -3003' };
calls = [];
assert.equal(await sendTelegram('<b>Hi</b>', multi), true);
assert.deepEqual(calls.map(c => c.body.chat_id), ['-1001', '2002', '-3003'], 'gửi tới mọi nơi');
// 1 nơi lỗi: các nơi khác vẫn nhận, không báo lỗi (tránh hàng chờ gửi lại làm trùng tin ở nơi đã nhận)
calls = [];
reply = () => calls.at(-1).body.chat_id === '2002' ? new Response('{"ok":false,"error_code":403,"description":"Forbidden: bot was kicked from the group chat"}', { status: 403 }) : new Response('{"ok":true}');
assert.equal(await sendTelegram('x', multi), true);
assert.equal(calls.length, 3);
const each = await sendTelegramEach('x', multi);
assert.deepEqual(each.map(r => r.ok), [true, false, true]);
assert.match(each[1].error, /bot đã bị xoá khỏi nhóm/);
// Mọi nơi đều lỗi: báo lỗi để hàng chờ gửi lại sau
reply = () => new Response('{"ok":false,"error_code":401,"description":"Unauthorized"}', { status: 401 });
await assert.rejects(sendTelegram('x', multi), /Bot token sai/);
reply = () => new Response('{"ok":true}');
assert.match(explainTelegram('{"ok":false,"error_code":400,"description":"Bad Request: group chat was upgraded to a supergroup chat","parameters":{"migrate_to_chat_id":-1009876}}'), /ID mới là -1009876/);
assert.match(explainTelegram('{"ok":false,"error_code":403,"description":"Forbidden: bot can\'t initiate conversation with a user"}'), /chưa bấm Start/);

// 5. Tất cả loại cảnh báo: HTML hợp lệ, ký tự đặc biệt trong email / tên máy / lý do được escape
const now = Date.now();
const acc = (id, email, extra) => ({ ts: now, account_id: id, email, ...extra });
const all = [
  acc(1, 'a<b>&c@test.com', { type: 'redeem_details_changed', old: { payment_method: 'paypal.com', email: 'a@test.com' }, new: { payment_method: 'paypal.com', email: 'thief@evil.com' }, foreign: true }),
  acc(1, 'a<b>&c@test.com', { type: 'withdraw_changed', why: 'lưu lịch rút hằng tuần 15:00 T5 qua PayPal tới a@test.com', ip: '1.2.3.4' }),
  acc(2, 'b@test.com', { type: 'account_banned', amount: 12.5 }),
  acc(3, 'c@test.com', { type: 'account_suspect', why: 'máy biến mất hết & số dư tụt <50%', amount: 3 }),
  acc(4, 'd@test.com', { type: 'withdraw_failed', why: 'EarnApp từ chối: <invalid>' }),
  acc(4, 'd@test.com', { type: 'withdraw_skipped', why: 'Số dư $3.00 chưa đủ mức rút tối thiểu $10.00 của PayPal' }),
  acc(4, 'd@test.com', { type: 'withdraw_ok', amount: 25, method: 'wise.com', to: 'd@test.com' }),
  acc(5, 'e@test.com', { type: 'auth' }),
  acc(5, 'e@test.com', { type: 'sync_error', why: 'EarnApp trả lỗi 503', since: now - 3600e3 }),
  acc(5, 'e@test.com', { type: 'rate_limit' }),
  acc(6, 'f@test.com', { type: 'device_banned', device: 'VPS<1>', reason: 'ip_quality' }),
  acc(6, 'f@test.com', { type: 'device_offline', device: 'VPS-2', last_seen: now - 1800e3 }),
  acc(6, 'f@test.com', { type: 'device_idle', device: 'VPS-3 & co' }),
  acc(6, 'f@test.com', { type: 'device_online', device: 'VPS-4' }),
  acc(6, 'f@test.com', { type: 'device_unbanned', device: 'VPS-5' }),
  acc(7, 'g@test.com', { type: 'payout_new', amount: 10, method: 'paypal.com' }),
  acc(7, 'g@test.com', { type: 'payout_paid', amount: 10, method: 'amazon.com (US/Global)' }),
  acc(7, 'g@test.com', { type: 'sync_ok' }),
];
const msg = formatAlerts(all, s);
checkHtml(msg, 'cảnh báo');
assert.ok(!msg.includes('null') && !msg.includes('undefined') && !msg.includes('NaN'), 'không có chữ null/undefined/NaN');
for (const a of all) assert.ok(msg.includes(esc(a.email)), `có tên acc ${a.email}`);
assert.match(msg, /a&lt;b&gt;&amp;c@test\.com/, 'email có ký tự đặc biệt được escape');
assert.match(msg, /VPS&lt;1&gt;/);
assert.match(msg, /\$12\.50 \(≈ 325\.000đ\)/, 'quy đổi VNĐ');
// Thứ tự: việc nghiêm trọng trước
assert.ok(msg.indexOf('Email nhận tiền trên EarnApp bị đổi') < msg.indexOf('Lịch rút tiền vừa thay đổi'));
assert.ok(msg.indexOf('Acc bị EarnApp KHOÁ') < msg.indexOf('Lệnh rút mới'));
preview('Tin cảnh báo (đủ mọi loại)', msg);

// Mỗi loại riêng lẻ cũng hợp lệ
for (const a of all) checkHtml(formatAlerts([a], s), a.type);

// 5b. Acc có tên riêng: tin hiện cả tên riêng và email
const named = formatAlerts([{ ...acc(20, 'z@test.com', { type: 'device_offline', device: 'VPS-9' }), label: 'A1' }], s);
assert.match(named, /👤 <b>A1 \(z@test\.com\)<\/b>/);

// 6. Lỗi giống nhau ở nhiều acc: gộp thành 1 mục
const many = [1, 2, 3, 4].map(i => acc(10 + i, `m${i}@test.com`, { type: 'auth' }));
const mergedMsg = formatAlerts(many, s);
checkHtml(mergedMsg, 'gộp');
assert.match(mergedMsg, /4 acc cookie hết hạn/);
assert.equal((mergedMsg.match(/👤/g) || []).length, 0, 'không tách thành từng acc');
preview('Tin gộp 4 acc cùng lỗi cookie', mergedMsg);

// 7. Rất nhiều cảnh báo: cắt nhiều tin, mỗi tin vẫn HTML hợp lệ
const flood = Array.from({ length: 60 }, (_, i) => acc(100 + i, `acc${i}@test.com`, { type: 'device_offline', device: `VPS-${i}-${'n'.repeat(30)}` }));
calls = [];
await sendTelegram(formatAlerts(flood, s), s);
assert.ok(calls.length > 1);
for (const c of calls) { assert.ok(c.body.text.length <= 4096); checkHtml(c.body.text, 'tin cắt'); }

// 8. Báo cáo hằng ngày (dữ liệu giả)
const ins = db.prepare('INSERT INTO accounts(email, cookie_enc, created_at, status, balance, earnings_total, last_ok_at, auth_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
ins.run('x<y>@test.com', encrypt('oauth-refresh-token=x'), now, 'running', 12.3, 100, now, 'expired'); // cookie hết hạn -> có tên trong mục cần xử lý
ins.run('stale@test.com', encrypt('oauth-refresh-token=x'), now, 'running', 5, 50, now - 5 * 3600e3, 'error');
ins.run('ban@test.com', encrypt('oauth-refresh-token=x'), now, 'banned', 7, 70, now, 'ok');
const accIds = db.prepare('SELECT id FROM accounts ORDER BY id').all().map(r => r.id);
const today = new Date(now + 7 * 3600e3).toISOString().slice(0, 10);
const yest = new Date(now + 7 * 3600e3 - 864e5).toISOString().slice(0, 10);
for (const id of accIds) {
  db.prepare('INSERT INTO account_daily(account_id, date, first_total, last_total) VALUES (?, ?, ?, ?)').run(id, today, 10, 11.234);
  db.prepare('INSERT INTO account_daily(account_id, date, first_total, last_total) VALUES (?, ?, ?, ?)').run(id, yest, 9, 10);
}
db.prepare("INSERT INTO devices(uuid, account_id, title, status, online, missing) VALUES ('d1', ?, 'VPS-1', 'online', 1, 0), ('d2', ?, 'VPS-2', 'offline', 0, 0)").run(accIds[0], accIds[0]);
const report = formatDailyReport(s, now);
checkHtml(report, 'báo cáo ngày');
assert.match(report, /Báo cáo \d\d\/\d\d/);
assert.match(report, /x&lt;y&gt;/, 'tên acc (lấy từ email) trong báo cáo được escape');
assert.match(report, /có vấn đề[\s\S]*→ dán cookie mới/, 'có mục vấn đề kèm việc cần làm');
assert.ok(report.split('\n').length <= 14, 'báo cáo gọn, không dài theo số acc');
assert.ok(!report.includes('undefined') && !report.includes('NaN'), 'báo cáo không có undefined/NaN');
assert.ok(report.length < 4096, 'báo cáo vừa 1 tin');
preview('Báo cáo hằng ngày', report);

// 8b. Có gán máy: tin cảnh báo gom theo máy -> acc -> node, máy chưa gán xuống cuối
const mAlerts = [
  { ...acc(31, 'b1@test.com', { type: 'device_offline', device: 'node3' }), label: 'B1', group_name: 'Máy B' },
  { ...acc(30, 'a2@test.com', { type: 'device_offline', device: 'node1' }), label: 'A2', group_name: 'Máy A' },
  { ...acc(32, 'x@test.com', { type: 'device_idle', device: 'node9' }) },
  { ...acc(29, 'a1@test.com', { type: 'device_banned', device: 'node2', reason: 'ip_quality' }), label: 'A1', group_name: 'Máy A' },
  { ...acc(30, 'a2@test.com', { type: 'device_offline', device: 'node5' }), label: 'A2', group_name: 'Máy A' },
];
const mMsg = formatAlerts(mAlerts, s);
checkHtml(mMsg, 'gom theo máy');
assert.equal((mMsg.match(/🗄 /g) || []).length, 3, '3 khối máy');
assert.ok(mMsg.indexOf('Máy A') < mMsg.indexOf('Máy B') && mMsg.indexOf('Máy B') < mMsg.indexOf('Chưa gán máy'), 'máy xếp theo tên, chưa gán xuống cuối');
assert.ok(mMsg.indexOf('A1 (a1') < mMsg.indexOf('A2 (a2'), 'acc trong máy xếp theo tên');
assert.match(mMsg, /🗄 <b>Máy A<\/b> · 2 acc/);
assert.match(mMsg, /2 node RỚT MẠNG[\s\S]*node1[\s\S]*node5/, 'node cùng acc gộp 1 mục');
preview('Tin cảnh báo gom theo máy', mMsg);
// Gộp nhiều acc cùng lỗi: danh sách acc chia theo máy
const mMerged = formatAlerts(['Máy A', 'Máy A', 'Máy B'].map((g, i) => ({ ...acc(40 + i, `c${i}@test.com`, { type: 'auth' }), label: `C${i}`, group_name: g })), s);
assert.match(mMerged, /▫️ <b>Máy A<\/b>: C0 \(c0@test\.com\), C1 \(c1@test\.com\)\n▫️ <b>Máy B<\/b>: C2/);
preview('Tin gộp, chia theo máy', mMerged);

// 8c. Báo cáo ngày khi có gán máy: mỗi máy 1 dòng, tên acc lỗi kèm máy, vẫn gọn
db.prepare("UPDATE accounts SET group_name = 'Máy A' WHERE id = ?").run(accIds[0]);
db.prepare("UPDATE accounts SET group_name = 'Máy B' WHERE id = ?").run(accIds[1]);
const mReport = formatDailyReport(s, now);
checkHtml(mReport, 'báo cáo theo máy');
assert.match(mReport, /🗄 <b>Máy A<\/b>: \$1\.23 · 1 acc · 1\/2 node chạy · ⚠️ 1 acc có vấn đề/);
assert.ok(mReport.indexOf('<b>Máy B</b>') < mReport.indexOf('<b>Chưa gán máy</b>'), 'chưa gán máy xuống cuối');
assert.match(mReport, /dán cookie mới trên web: Máy A: x&lt;y&gt;/, 'tên acc lỗi kèm máy');
assert.ok(mReport.split('\n').length <= 20 && mReport.length < 4096);
preview('Báo cáo hằng ngày (có gán máy)', mReport);

globalThis.fetch = realFetch;
console.log('✓ test-telegram: tất cả đều đúng');
process.exit(0);
