import { db, tx, addEvent, getSettings } from './db.js';
import { cmp } from './accname.js';
import { localDate, usageToday } from './stats.js';

// Máy = máy thật / VPS chạy nhiều acc EarnApp, mỗi acc chạy nhiều node.
// Quy trình: tạo máy trước -> thêm acc thì chọn máy -> node của acc tự hiện theo máy.
// Acc lưu tên máy trong accounts.group_name (khớp machines.name, không phân biệt hoa/thường).

export const NAME_MAX = 40;
export const NO_MACHINE = 'Chưa gán máy';

export class MachineError extends Error {}

const cleanName = v => String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
// So tên không phân biệt hoa/thường, đúng cả chữ có dấu ("MÁY A" = "Máy A"); SQLite NOCASE chỉ hiểu chữ không dấu
const key = n => n.toLocaleLowerCase('vi');
const findByName = (n, exceptId = 0) => db.prepare('SELECT * FROM machines').all().find(m => m.id !== exceptId && key(m.name) === key(n));

export const getMachine = id => db.prepare('SELECT * FROM machines WHERE id = ?').get(id);

/**
 * Tên máy người dùng chọn -> tên chuẩn đã lưu. '' = chưa gán máy.
 * Máy chưa tạo thì báo lỗi (phải tạo máy trước rồi mới gán acc).
 */
export function resolveMachine(name) {
  const n = cleanName(name);
  if (!n) return '';
  const m = findByName(n);
  if (!m) throw new MachineError(`Chưa có máy "${n}". Tạo máy trước trong mục Máy rồi chọn lại`);
  return m.name;
}

function checkName(name, exceptId = 0) {
  const n = cleanName(name);
  if (!n) throw new MachineError('Chưa nhập tên máy');
  if (n.toLowerCase() === NO_MACHINE.toLowerCase()) throw new MachineError(`"${NO_MACHINE}" là tên dành riêng, đặt tên khác`);
  if (n.length > NAME_MAX) throw new MachineError(`Tên máy tối đa ${NAME_MAX} ký tự`);
  const dup = findByName(n, exceptId);
  if (dup) throw new MachineError(`Đã có máy "${dup.name}"`);
  return n;
}

export function createMachine({ name, note = '' }) {
  const n = checkName(name);
  const r = db.prepare('INSERT INTO machines(name, note, created_at) VALUES (?, ?, ?)').run(n, String(note ?? '').trim(), Date.now());
  addEvent({ type: 'machine', message: `Đã tạo máy "${n}"` });
  return getMachine(Number(r.lastInsertRowid));
}

/** Sửa tên / ghi chú. Đổi tên thì mọi acc của máy đổi theo (cùng 1 giao dịch) */
export function updateMachine(id, b = {}) {
  const m = getMachine(id);
  if (!m) throw new MachineError('Không tìm thấy máy');
  const name = 'name' in b ? checkName(b.name, m.id) : m.name;
  const note = 'note' in b ? String(b.note ?? '').trim() : m.note;
  tx(() => {
    db.prepare('UPDATE machines SET name = ?, note = ? WHERE id = ?').run(name, note, m.id);
    if (name !== m.name) db.prepare('UPDATE accounts SET group_name = ? WHERE group_name = ?').run(name, m.name);
  });
  if (name !== m.name) addEvent({ type: 'machine', message: `Đổi tên máy "${m.name}" thành "${name}"` });
  return getMachine(m.id);
}

/**
 * Xoá máy. Còn acc đang theo dõi thì không cho xoá (chuyển acc sang máy khác trước).
 * Acc đã lưu trữ của máy chuyển về "Chưa gán máy".
 */
export function deleteMachine(id) {
  const m = getMachine(id);
  if (!m) throw new MachineError('Không tìm thấy máy');
  const active = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE group_name = ? AND archived_at IS NULL').get(m.name).n;
  if (active) throw new MachineError(`"${m.name}" còn ${active} acc. Chuyển các acc sang máy khác trước khi xoá`);
  tx(() => {
    db.prepare("UPDATE accounts SET group_name = '' WHERE group_name = ?").run(m.name);
    db.prepare('DELETE FROM machines WHERE id = ?').run(m.id);
  });
  addEvent({ type: 'machine', message: `Đã xoá máy "${m.name}"` });
}

/** Chuyển nhiều acc vào 1 máy ('' = bỏ khỏi máy) */
export function moveAccounts(ids, name) {
  const target = resolveMachine(name);
  const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!list.length) throw new MachineError('Chưa chọn acc');
  const up = db.prepare('UPDATE accounts SET group_name = ? WHERE id = ?');
  let n = 0;
  tx(() => { for (const id of list) n += Number(up.run(target, id).changes); });
  return n;
}

/** Danh sách máy kèm số liệu (cả máy chưa có acc). Có thêm dòng "Chưa gán máy" nếu còn acc chưa gán */
export function listMachines() {
  const s = getSettings();
  const today = localDate(Date.now(), s.timezone);
  const stats = db.prepare(`
    SELECT a.group_name AS name,
      SUM(a.archived_at IS NULL) AS accounts,
      SUM(a.archived_at IS NOT NULL) AS archived,
      COALESCE(SUM(CASE WHEN a.archived_at IS NULL THEN COALESCE((SELECT last_total - first_total FROM account_daily ad WHERE ad.account_id = a.id AND ad.date = ?), 0) END), 0) AS today,
      COALESCE(SUM(CASE WHEN a.archived_at IS NULL AND a.status != 'banned' THEN a.balance END), 0) AS balance,
      COALESCE(SUM(CASE WHEN a.archived_at IS NULL THEN (SELECT COALESCE(SUM(bytes), 0) FROM device_usage u WHERE u.account_id = a.id AND u.date = ?) END), 0) AS usage_today
    FROM accounts a GROUP BY a.group_name`).all(today, usageToday());
  const dev = db.prepare(`
    SELECT a.group_name AS name, d.status, COUNT(*) AS n
    FROM devices d JOIN accounts a ON a.id = d.account_id
    WHERE d.missing = 0 AND a.archived_at IS NULL GROUP BY a.group_name, d.status`).all();
  const empty = { accounts: 0, archived: 0, today: 0, balance: 0, usage_today: 0 };
  const row = (name, base) => {
    const st = stats.find(x => x.name === name) || empty;
    const devices = { online: 0, idle: 0, offline: 0, banned: 0, unknown: 0 };
    for (const d of dev.filter(x => x.name === name)) devices[d.status] = (devices[d.status] || 0) + d.n;
    return { ...base, accounts: st.accounts, archived: st.archived, today: st.today, balance: st.balance, usage_today: st.usage_today,
      devices, dev_total: Object.values(devices).reduce((a, b) => a + b, 0) };
  };
  const out = db.prepare('SELECT * FROM machines').all().sort((a, b) => cmp(a.name, b.name)).map(m => row(m.name, m));
  const none = row('', { id: null, name: '', note: '' });
  if (none.accounts) out.push(none);
  return out;
}
