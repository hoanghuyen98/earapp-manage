import { getSettings } from './db.js';

export const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export async function sendTelegram(text, s = getSettings()) {
  if (!s.telegram_token || !s.telegram_chat_id) return false;
  // Telegram giới hạn 4096 ký tự / tin
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + line).length > 3900) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${s.telegram_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: s.telegram_chat_id, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('Telegram: ' + (await res.text()).slice(0, 200));
  }
  return true;
}
