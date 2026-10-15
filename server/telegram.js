import { getSettings } from './db.js';

export const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const LINE_MAX = 3800;
/** Dòng quá dài (hiếm): bỏ thẻ HTML rồi cắt, không để cả tin bị Telegram từ chối mãi */
const fitLine = line => line.length <= LINE_MAX ? line
  : line.replace(/<[^>]*>/g, '').slice(0, LINE_MAX).replace(/&[a-z#0-9]*$/i, '') + '…';

/** Nhiều nơi nhận: chat riêng, nhóm (số âm) hoặc @kênh, cách nhau bằng dấu phẩy */
export const chatIds = v => [...new Set(String(v ?? '').split(/[\s,;]+/).filter(Boolean))];
export const validChatId = id => /^(-?\d{3,20}|@[A-Za-z0-9_]{5,32})$/.test(id);

function toChunks(text) {
  // Telegram giới hạn 4096 ký tự / tin
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n').map(fitLine)) {
    if (cur && (cur + line).length > 3900) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function sendTo(chat, chunks, token) {
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('Telegram: ' + explainTelegram(await res.text()));
  }
}

/** Lỗi Telegram -> câu dễ hiểu */
export function explainTelegram(body) {
  let j = {};
  try { j = JSON.parse(body); } catch { return String(body).slice(0, 200); }
  const d = String(j.description || '');
  if (j.parameters?.migrate_to_chat_id) return `nhóm đã được nâng cấp, ID mới là ${j.parameters.migrate_to_chat_id}`;
  if (/chat not found/i.test(d)) return 'không tìm thấy chat (sai ID, hoặc bot chưa ở trong nhóm)';
  if (/bot was kicked|bot is not a member/i.test(d)) return 'bot đã bị xoá khỏi nhóm';
  if (/bot can't initiate|bot was blocked/i.test(d)) return 'chưa bấm Start với bot, hoặc đã chặn bot';
  if (/not enough rights|have no rights/i.test(d)) return 'bot không có quyền gửi tin trong nhóm';
  if (j.error_code === 401 || /Unauthorized/i.test(d)) return 'Bot token sai';
  return d.slice(0, 200) || String(body).slice(0, 200);
}

/** Gửi tới từng nơi nhận, trả về kết quả từng nơi: [{ chat, ok, error }] */
export async function sendTelegramEach(text, s = getSettings()) {
  const chats = chatIds(s.telegram_chat_id);
  if (!s.telegram_token || !chats.length) return [];
  const chunks = toChunks(text);
  const out = [];
  for (const chat of chats) {
    try { await sendTo(chat, chunks, s.telegram_token); out.push({ chat, ok: true }); }
    catch (e) { out.push({ chat, ok: false, error: e.message }); }
  }
  return out;
}

/**
 * Gửi tới mọi nơi nhận. Chỉ báo lỗi (để hàng chờ gửi lại) khi KHÔNG nơi nào nhận được;
 * lỗi ở 1 vài nơi thì ghi log, không gửi lại để các nơi đã nhận không bị trùng tin.
 */
export async function sendTelegram(text, s = getSettings()) {
  const res = await sendTelegramEach(text, s);
  if (!res.length) return false;
  const failed = res.filter(r => !r.ok);
  if (failed.length === res.length) throw new Error(failed[0].error);
  for (const f of failed) console.error(`telegram ${f.chat}: ${f.error}`);
  return true;
}
