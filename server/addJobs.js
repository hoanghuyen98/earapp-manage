import { db, getSettings, addEvent } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { addAccounts, checkInput, toLines } from './addAccounts.js';
import { runCycle, getProgress } from './sync.js';
import { sendTelegram, esc } from './telegram.js';
import { explainError } from './alerts.js';
import { normalizeProxy } from './earnapp.js';

// Thêm acc chạy ngầm: admin bấm Thêm là xong, server tự kiểm tra cookie + tải dữ liệu lần đầu,
// xong thì báo trên web (thẻ ở đầu trang) và 1 tin Telegram cho cả lượt.
// Lượt đang chạy lưu trong database nên web khởi động lại vẫn chạy tiếp (resumeJobs).

const LIST_MAX = 5;
const getJob = id => db.prepare('SELECT * FROM add_jobs WHERE id = ?').get(id);
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Lý do lỗi dễ hiểu cho admin */
export function reason(msg = '') {
  if (/auth required|unauthori[sz]ed|not logged/i.test(msg)) return 'Cookie sai hoặc đã hết hạn';
  return explainError(msg);
}
// Lỗi do cookie (sai định dạng, hết hạn, trùng): thử lại cookie cũ vô ích, phải lấy cookie mới
const cookieError = msg => /auth required|unauthori[sz]ed|not logged|cookie/i.test(msg || '');

/** Nhận việc: kiểm tra phần chung (máy, số dòng…) rồi chạy ngầm. Sai phần chung thì báo lỗi ngay */
export function startAddJob(input, defaults = {}) {
  const lines = checkInput(input, defaults);
  const rows = lines.map(({ no, cookie, label, machine, proxy }) => ({ no, cookie, label, machine, proxy }));
  const r = db.prepare('INSERT INTO add_jobs(created_at, group_name, total, rows_enc) VALUES (?, ?, ?, ?)')
    .run(Date.now(), String(defaults.group_name || ''), rows.length, encrypt(JSON.stringify({ rows, defaults })));
  const id = Number(r.lastInsertRowid);
  runJob(id).catch(e => console.error('add job', id, e));
  return viewJob(getJob(id));
}

/**
 * Nhập từ file danh sách acc (backup.js): acc đã vào database rồi, lượt này chỉ còn tải dữ liệu lần đầu ở nền.
 * results: [{ ok: true, id, email, label, group_name, updated, line }]
 */
export function startImportJob(results) {
  const r = db.prepare("INSERT INTO add_jobs(created_at, kind, total, results) VALUES (?, 'import', ?, ?)")
    .run(Date.now(), results.length, JSON.stringify(results.map(x => ({ ...x, resync: true }))));
  const id = Number(r.lastInsertRowid);
  runJob(id).catch(e => console.error('import job', id, e));
  return viewJob(getJob(id));
}

const running = new Map();
export function runJob(id) {
  if (!running.has(id)) running.set(id, doRun(id).finally(() => running.delete(id)));
  return running.get(id);
}

async function doRun(id) {
  const job = getJob(id);
  if (!job || job.finished_at) return;
  const { rows, defaults } = job.rows_enc ? parse(decrypt(job.rows_enc), { rows: [], defaults: {} }) : { rows: [], defaults: {} };
  const results = parse(job.results, []);
  const persist = () => db.prepare('UPDATE add_jobs SET results = ? WHERE id = ?').run(JSON.stringify(results), id);
  const syncs = [];
  // Acc đã lưu mà chưa lấy dữ liệu lần nào (web vừa khởi động lại giữa chừng, hoặc acc nhập từ file) thì lấy luôn
  for (const r of results) {
    const a = r.ok && db.prepare('SELECT last_sync_at, archived_at FROM accounts WHERE id = ?').get(r.id);
    if (a && !a.archived_at && (r.resync || !a.last_sync_at)) syncs.push(runCycle([r.id]));
  }
  const done = new Set(results.map(r => r.line));
  const todo = toLines(rows).filter(l => !done.has(l.no));
  if (todo.length) {
    try {
      await addAccounts(todo, defaults, {
        onResult: r => {
          results.push(r);
          persist();
          // Acc nào kiểm tra xong thì tải dữ liệu luôn, không chờ cả lô
          if (r.ok) syncs.push(runCycle([r.id]));
        },
      });
    } catch (e) {
      // Lỗi phần chung giữa chừng (vd. máy vừa bị xoá): các dòng còn lại báo lỗi
      for (const l of todo) if (!results.some(r => r.line === l.no)) results.push({ ok: false, error: e.message, label: l.label || null, line: l.no });
      persist();
    }
  }
  await Promise.allSettled(syncs);
  // Xong: chỉ giữ lại các dòng lỗi (đã mã hoá) để bấm Thử lại; cookie dòng đã thêm không cần giữ nữa
  const failedLines = new Set(results.filter(r => !r.ok).map(r => r.line));
  const failedRows = rows.filter(r => failedLines.has(r.no));
  db.prepare('UPDATE add_jobs SET finished_at = ?, results = ?, rows_enc = ? WHERE id = ?')
    .run(Date.now(), JSON.stringify(results), failedRows.length ? encrypt(JSON.stringify({ rows: failedRows, defaults })) : '', id);
  const v = viewJob(getJob(id));
  addEvent({ type: 'account_added', level: v.failed || v.sync_failed ? 'warning' : 'info',
    message: `${v.kind === 'import' ? 'Nhập acc từ file' : 'Thêm acc'} xong${v.group_name ? ` (${v.group_name})` : ''}: ${v.added} mới, ${v.updated} cập nhật, ${v.failed} lỗi` });
  const s = getSettings();
  if (s.notify_add_done) await sendTelegram(formatAddJob(v), s).catch(e => console.error('telegram', e.message));
}

/** Web khởi động: chạy tiếp các lượt chưa xong, dọn lượt cũ */
export function resumeJobs() {
  db.prepare('DELETE FROM add_jobs WHERE created_at < ?').run(Date.now() - 7 * 864e5);
  for (const { id } of db.prepare('SELECT id FROM add_jobs WHERE finished_at IS NULL').all()) runJob(id).catch(e => console.error('add job', id, e));
}

/** Tình trạng 1 lượt cho giao diện: từng dòng + tiến độ tải dữ liệu của acc đã thêm */
export function viewJob(job) {
  const results = parse(job.results, []).sort((a, b) => a.line - b.line);
  const ok = results.filter(r => r.ok);
  const prog = Object.fromEntries(getProgress(ok.map(r => r.id)).map(p => [p.id, p]));
  // Dòng lỗi mạng / proxy còn thử lại được: gửi kèm proxy đang dùng để admin sửa ngay trên thẻ (cookie không gửi ra)
  const canRetry = r => !r.ok && !cookieError(r.error);
  const retryable = job.finished_at && job.rows_enc ? results.filter(canRetry) : [];
  const proxyOf = retryable.length ? rowProxies(job) : {};
  const items = results.map(r => r.ok ? { ...r, sync: prog[r.id] || null }
    : { ...r, reason: reason(r.error), ...(retryable.includes(r) ? { retry: true, proxy: proxyOf[r.line] || '' } : {}) });
  const syncState = r => r.sync?.state;
  return {
    id: job.id, kind: job.kind || 'add', created_at: job.created_at, finished_at: job.finished_at, group_name: job.group_name, total: job.total,
    checked: results.length,
    added: ok.filter(r => !r.updated).length,
    updated: ok.filter(r => r.updated).length,
    failed: results.length - ok.length,
    loaded: items.filter(r => r.ok && syncState(r) === 'done').length,
    sync_failed: items.filter(r => r.ok && syncState(r) === 'error').length,
    // Thử lại chỉ có ích với lỗi mạng / proxy
    retryable: retryable.length,
    items,
  };
}

export const listJobs = () => db.prepare('SELECT * FROM add_jobs WHERE seen = 0 ORDER BY id DESC').all().map(viewJob);

/** Admin đóng thông báo: xoá luôn cookie dòng lỗi còn giữ */
export function dismissJob(id) {
  db.prepare("UPDATE add_jobs SET seen = 1, rows_enc = '' WHERE id = ? AND finished_at IS NOT NULL").run(id);
}

/** Proxy từng dòng của 1 lượt: proxy riêng của dòng, không có thì proxy chung của lượt. { số dòng: proxy } */
function rowProxies(job) {
  const { rows = [], defaults = {} } = parse(job.rows_enc ? decrypt(job.rows_enc) : '', {});
  return Object.fromEntries(rows.map(r => [r.no, r.proxy || defaults.proxy || '']));
}

/**
 * Thêm lại các dòng lỗi mạng / proxy của 1 lượt đã xong (cookie không rời khỏi server).
 * proxies: { số dòng: proxy mới } admin sửa trên thẻ; dòng không sửa giữ proxy cũ
 */
export function retryJob(id, proxies = {}) {
  const job = getJob(id);
  const lines = new Set(parse(job?.results, []).filter(r => !r.ok && !cookieError(r.error)).map(r => r.line));
  if (!job?.finished_at || !job.rows_enc || !lines.size) throw new Error('Không còn acc lỗi mạng / proxy để thử lại');
  const { rows, defaults } = parse(decrypt(job.rows_enc), { rows: [], defaults: {} });
  const old = rowProxies(job);
  const retry = rows.filter(r => lines.has(r.no)).map(({ no, ...r }) => {
    const proxy = no in proxies ? String(proxies[no] ?? '').trim() : old[no];
    try { normalizeProxy(proxy); } catch (e) { throw new Error(`Acc ${no}${r.label ? ` (${r.label})` : ''}: ${e.message}`); }
    return { ...r, proxy };
  });
  // Proxy đã ghi riêng từng dòng: bỏ proxy chung để dòng xoá trống proxy thì đi thẳng, không lấy lại proxy chung
  const next = startAddJob(retry, { ...defaults, proxy: '' });
  dismissJob(id);
  return next;
}

const accLabel = r => r.label ? `${r.label} (${r.email})` : r.email;

/** 1 tin Telegram cho cả lượt: ngắn, lỗi nào cũng kèm việc cần làm */
export function formatAddJob(v) {
  const bad = v.failed + v.sync_failed;
  const where = v.group_name ? ` · ${esc(v.group_name)}` : '';
  const lines = [`${bad ? '⚠️' : '✅'} <b>${v.kind === 'import' ? 'Nhập acc từ file' : 'Thêm acc'} xong${where}</b>`];
  const okParts = [v.added && `${v.added} acc mới`, v.updated && `${v.updated} acc cập nhật cookie`].filter(Boolean);
  if (okParts.length) lines.push(`• ${okParts.join(', ')}${v.loaded ? `, đã tải dữ liệu ${v.loaded} acc` : ''}`);
  const list = (items, fmt) => {
    const out = items.slice(0, LIST_MAX).map(r => '▫️ ' + fmt(r));
    if (items.length > LIST_MAX) out.push(`▫️ … và ${items.length - LIST_MAX} acc khác`);
    return out;
  };
  const failed = v.items.filter(r => !r.ok);
  if (failed.length) {
    lines.push(`• ❌ ${failed.length} acc không thêm được:`);
    lines.push(...list(failed, r => `Acc ${r.line}${r.label ? ` (${esc(r.label)})` : ''}: ${esc(r.reason)}`));
  }
  const syncBad = v.items.filter(r => r.ok && r.sync?.state === 'error');
  if (syncBad.length) {
    lines.push(`• ⚠️ ${syncBad.length} acc đã thêm nhưng chưa lấy được dữ liệu:`);
    lines.push(...list(syncBad, r => `${esc(accLabel(r))}: ${esc(reason(r.sync.error))}`));
  }
  const cookieBad = failed.filter(r => cookieError(r.error ?? r.reason)).length;
  if (cookieBad) lines.push('👉 Acc lỗi cookie: lấy cookie mới rồi thêm lại acc đó');
  if (failed.length > cookieBad) lines.push('👉 Acc lỗi mạng / proxy: sửa proxy ngay trên thông báo ở web rồi bấm "Thêm lại"');
  else if (syncBad.length) lines.push('👉 Web tự thử lại theo lịch. Lỗi mãi thì kiểm tra proxy của acc đó');
  return lines.join('\n');
}
