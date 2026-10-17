import { db, addEvent } from './db.js';
import { encrypt } from './crypto.js';
import { normalizeCookie, normalizeProxy, EarnAppClient } from './earnapp.js';
import { resolveMachine } from './machines.js';

// Thêm acc hàng loạt. Mỗi dòng: cookie, hoặc  cookie | tên riêng | máy | proxy
// (dán từ Excel thì cột cách nhau bằng Tab cũng được). Ô để trống thì lấy theo ô chung trên form.
// Dòng trống và dòng bắt đầu bằng # bị bỏ qua.

export const MAX_LINES = 300;
const CHECK_PARALLEL = 3; // kiểm tra cookie song song, ít thôi để EarnApp không chặn

export function parseLines(text) {
  return String(text || '').split(/\r?\n/).map((raw, i) => ({ raw: raw.trim(), no: i + 1 }))
    .filter(l => l.raw && !l.raw.startsWith('#'))
    .map(({ raw, no }) => {
      const [cookie = '', label = '', machine = '', proxy = ''] = raw.split(/[|\t]/).map(s => s.trim());
      return { no, cookie, label, machine, proxy };
    });
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Chữ (mỗi dòng 1 acc) hoặc mảng [{ cookie, label, machine, proxy, no? }] -> các dòng có cookie */
export function toLines(input) {
  return Array.isArray(input)
    ? input.map((r, i) => ({ no: Number(r?.no) || i + 1, ...Object.fromEntries(['cookie', 'label', 'machine', 'proxy'].map(k => [k, String(r?.[k] ?? '').trim()])) })).filter(l => l.cookie)
    : parseLines(input);
}

/** Kiểm tra phần chung của form trước khi nhận việc (sai thì báo ngay, không chạy ngầm) */
export function checkInput(input, defaults = {}) {
  const lines = toLines(input);
  if (!lines.length) throw new Error('Chưa nhập cookie');
  if (lines.length > MAX_LINES) throw new Error(`Mỗi lần thêm tối đa ${MAX_LINES} acc (đang có ${lines.length} dòng)`);
  normalizeProxy(defaults.proxy);
  resolveMachine(defaults.group_name);
  return lines;
}

/**
 * input: chữ (mỗi dòng 1 acc) hoặc mảng dòng. Kiểm tra cookie song song, dòng nào xong thì lưu ngay
 * (lưu là đồng bộ, không chen ngang được, nên 2 dòng cùng email không tạo 2 acc) và gọi onResult(kết quả).
 * defaults: { label, note, group_name, proxy } là ô chung trên form.
 * Trả về [{ ok, email, id, updated, moved, line }] / [{ ok: false, error, line }] theo thứ tự dòng
 */
export async function addAccounts(input, defaults = {}, { onResult = () => {} } = {}) {
  const lines = checkInput(input, defaults);
  const single = lines.length === 1;
  const baseLabel = String(defaults.label || '').trim().slice(0, 40);
  const note = String(defaults.note || '');
  const baseProxy = normalizeProxy(defaults.proxy);
  const baseMachine = resolveMachine(defaults.group_name);

  // Đọc và kiểm tra từng dòng, chưa gọi EarnApp
  const seen = new Map();
  const prepared = lines.map(l => {
    try {
      const cookie = normalizeCookie(l.cookie);
      if (seen.has(cookie)) throw new Error(`Trùng cookie với dòng ${seen.get(cookie)}`);
      seen.set(cookie, l.no);
      return {
        ...l, cookie,
        label: (l.label || (single ? baseLabel : '')).slice(0, 40),
        group_name: l.machine ? resolveMachine(l.machine) : baseMachine,
        proxy: l.proxy ? normalizeProxy(l.proxy) : baseProxy,
        ownProxy: !!l.proxy,
      };
    } catch (e) { return { ...l, error: e.message }; }
  });

  return mapLimit(prepared, CHECK_PARALLEL, async p => {
    if (!p.error) {
      try { p = { ...p, user: await new EarnAppClient(p.cookie, p.proxy).call('user_data') }; }
      catch (e) { p = { ...p, error: e.message }; }
    }
    const r = save(p, { note });
    onResult(r);
    return r;
  });
}

/** Lưu 1 dòng đã kiểm tra: acc mới thì thêm, acc đã có (cùng email) thì cập nhật cookie */
function save(p, { note }) {
  const line = p.no;
  if (p.error) return { ok: false, error: p.error, label: p.label || null, line };
  const email = p.user.email;
  const dup = db.prepare('SELECT id, group_name FROM accounts WHERE email = ?').get(email);
  if (dup) {
    db.prepare("UPDATE accounts SET cookie_enc = ?, auth_state = 'pending', archived_at = NULL, paused = 0 WHERE id = ?").run(encrypt(p.cookie), dup.id);
    if (p.label) db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(p.label, dup.id);
    // Có ghi proxy riêng cho dòng này thì cập nhật proxy của acc
    if (p.ownProxy) db.prepare('UPDATE accounts SET proxy = ? WHERE id = ?').run(p.proxy, dup.id);
    // Thêm lại acc đã có mà chọn máy khác: chuyển acc sang máy đó
    const moved = p.group_name && p.group_name !== (dup.group_name || '');
    if (moved) db.prepare('UPDATE accounts SET group_name = ? WHERE id = ?').run(p.group_name, dup.id);
    return { ok: true, email, updated: true, moved: moved ? p.group_name : null, id: dup.id, label: p.label || null, group_name: p.group_name, line };
  }
  const r = db.prepare('INSERT INTO accounts(email, label, note, group_name, cookie_enc, proxy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(email, p.label || null, note, p.group_name, encrypt(p.cookie), p.proxy, Date.now());
  const id = Number(r.lastInsertRowid);
  addEvent({ account_id: id, type: 'account_added', message: `Đã thêm acc ${email}` });
  return { ok: true, email, id, label: p.label || null, group_name: p.group_name, line };
}
