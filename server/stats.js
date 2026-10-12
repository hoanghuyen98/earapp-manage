import { db, getSettings } from './db.js';

export const localDate = (ts, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ts);

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const round = n => Math.round((n || 0) * 1000) / 1000;

/** Byte -> chuỗi dễ đọc, hệ 1000 giống EarnApp */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(2) + ' TB';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' KB';
  return v + ' B';
}

/** Ngày mới nhất EarnApp đã trả dung lượng (EarnApp chia ngày theo giờ của họ) */
export function usageToday() {
  return db.prepare('SELECT MAX(date) AS d FROM device_usage').get().d
    || localDate(Date.now(), getSettings().timezone);
}

/** Dung lượng theo tháng (byte), N tháng gần nhất */
export function usageMonthly(months = 6, { accountId } = {}) {
  const last = (usageToday() || '').slice(0, 7);
  const [y, m] = last.split('-').map(Number);
  const list = Array.from({ length: months }, (_, i) => new Date(Date.UTC(y, m - 1 - (months - 1 - i), 1)).toISOString().slice(0, 7));
  const rows = accountId
    ? db.prepare('SELECT month, SUM(bytes) AS v FROM device_usage_monthly WHERE account_id = ? AND month >= ? GROUP BY month').all(accountId, list[0])
    : db.prepare('SELECT month, SUM(bytes) AS v FROM device_usage_monthly WHERE month >= ? GROUP BY month').all(list[0]);
  const map = Object.fromEntries(rows.map(r => [r.month, r.v]));
  return list.map(month => ({ month, value: map[month] || 0 }));
}

/** Dung lượng theo ngày (byte), đủ N ngày tính tới ngày mới nhất */
export function usageSeries(days = 7, { accountId, uuid } = {}) {
  const last = usageToday();
  const from = addDays(last, -(days - 1));
  let rows;
  if (uuid) rows = db.prepare('SELECT date, bytes AS v FROM device_usage WHERE uuid = ? AND date >= ?').all(uuid, from);
  else if (accountId) rows = db.prepare('SELECT date, SUM(bytes) AS v FROM device_usage WHERE account_id = ? AND date >= ? GROUP BY date').all(accountId, from);
  else rows = db.prepare('SELECT date, SUM(bytes) AS v FROM device_usage WHERE date >= ? GROUP BY date').all(from);
  const map = Object.fromEntries(rows.map(r => [r.date, r.v]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    return { date, value: map[date] || 0 };
  });
}

/** 4 mục tổng + số liệu tổng quan */
export function summary() {
  const s = getSettings();
  const today = localDate(Date.now(), s.timezone);
  const t = db.prepare(`
    SELECT
      COALESCE(SUM(earnings_total), 0) AS lifetime,
      COALESCE(SUM(CASE WHEN status != 'banned' THEN balance END), 0) AS current,
      COALESCE(SUM(CASE WHEN status = 'banned' THEN balance END), 0) AS banned,
      COUNT(*) AS accounts,
      SUM(status = 'running') AS running,
      SUM(status = 'stopped') AS stopped,
      SUM(status = 'banned') AS banned_accounts,
      SUM(auth_state IN ('expired', 'error')) AS auth_problems,
      SUM(suspect_reason != '') AS suspects,
      SUM(backoff_until > ?) AS rate_limited
    FROM accounts`).get(Date.now());
  const w = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN status != 'paid' THEN amount END), 0) AS pending,
      SUM(status != 'paid') AS pending_count
    FROM transactions`).get();
  const d = db.prepare(`
    SELECT
      SUM(d.status = 'online') AS online, SUM(d.status = 'idle') AS idle,
      SUM(d.status = 'offline') AS offline, SUM(d.status = 'banned') AS banned
    FROM devices d WHERE d.missing = 0`).get();
  const earn = date => db.prepare('SELECT COALESCE(SUM(last_total - first_total), 0) AS v FROM account_daily WHERE date = ?').get(date).v;
  const month = db.prepare('SELECT COALESCE(SUM(last_total - first_total), 0) AS v FROM account_daily WHERE date >= ?').get(today.slice(0, 8) + '01').v;

  const uDay = usageToday();
  const usageSum = (from, to) => db.prepare('SELECT COALESCE(SUM(bytes), 0) AS v FROM device_usage WHERE date >= ? AND date <= ?').get(from, to).v;

  return {
    usage_today: usageSum(uDay, uDay), usage_yesterday: usageSum(addDays(uDay, -1), addDays(uDay, -1)),
    usage_7d: usageSum(addDays(uDay, -6), uDay),
    usage_month: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS v FROM device_usage_monthly WHERE month = ?').get(uDay.slice(0, 7)).v
      || usageSum(uDay.slice(0, 8) + '01', uDay),
    lifetime: round(t.lifetime), current: round(t.current), withdrawn: round(w.withdrawn), banned: round(t.banned),
    pending: round(w.pending), pending_count: w.pending_count || 0,
    today: round(earn(today)), yesterday: round(earn(addDays(today, -1))), month: round(month),
    accounts: { total: t.accounts, running: t.running || 0, stopped: t.stopped || 0, banned: t.banned_accounts || 0, auth_problems: t.auth_problems || 0, suspects: t.suspects || 0, rate_limited: t.rate_limited || 0 },
    devices: { online: d.online || 0, idle: d.idle || 0, offline: d.offline || 0, banned: d.banned || 0 },
    usd_vnd: s.usd_vnd,
  };
}

/** Thu nhập theo ngày trong N ngày gần nhất (đủ ngày, kể cả ngày = 0) */
export function dailySeries(days = 30, { accountId, uuid } = {}) {
  const s = getSettings();
  const today = localDate(Date.now(), s.timezone);
  const from = addDays(today, -(days - 1));
  let rows;
  if (uuid) rows = db.prepare('SELECT date, last_total - first_total AS v FROM device_daily WHERE uuid = ? AND date >= ?').all(uuid, from);
  else if (accountId) rows = db.prepare('SELECT date, last_total - first_total AS v FROM account_daily WHERE account_id = ? AND date >= ?').all(accountId, from);
  else rows = db.prepare('SELECT date, SUM(last_total - first_total) AS v FROM account_daily WHERE date >= ? GROUP BY date').all(from);
  const map = Object.fromEntries(rows.map(r => [r.date, r.v]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    return { date, value: round(map[date]) };
  });
}

/** Lãi lỗ theo tháng: thu nhập (quy ra VND) - chi phí */
export function profitByMonth(months = 6) {
  const s = getSettings();
  const today = localDate(Date.now(), s.timezone);
  const result = [];
  const [y, m] = today.split('-').map(Number);
  const costs = db.prepare('SELECT * FROM costs').all();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const ym = d.toISOString().slice(0, 7);
    const earnUsd = db.prepare("SELECT COALESCE(SUM(last_total - first_total), 0) AS v FROM account_daily WHERE substr(date, 1, 7) = ?").get(ym).v;
    let cost = 0;
    for (const c of costs) {
      if (c.period === 'once') { if (c.date.slice(0, 7) === ym) cost += c.amount; }
      else if (c.date.slice(0, 7) <= ym && (!c.end_date || c.end_date.slice(0, 7) >= ym)) cost += c.amount;
    }
    const income = earnUsd * s.usd_vnd;
    result.push({ month: ym, earn_usd: round(earnUsd), income_vnd: Math.round(income), cost_vnd: Math.round(cost), profit_vnd: Math.round(income - cost) });
  }
  return result;
}

/** Xếp hạng máy theo thu nhập N ngày */
export function deviceRanking(days = 7) {
  const s = getSettings();
  const from = addDays(localDate(Date.now(), s.timezone), -(days - 1));
  return db.prepare(`
    SELECT d.uuid, d.title, d.status, d.country, a.id AS account_id, COALESCE(a.label, a.email) AS account,
      COALESCE(SUM(dd.last_total - dd.first_total), 0) AS earned,
      COALESCE((SELECT SUM(bytes) FROM device_usage u WHERE u.uuid = d.uuid AND u.date >= ?), 0) AS bytes
    FROM devices d JOIN accounts a ON a.id = d.account_id
    LEFT JOIN device_daily dd ON dd.uuid = d.uuid AND dd.date >= ?
    WHERE d.missing = 0
    GROUP BY d.uuid ORDER BY earned DESC`).all(addDays(usageToday(), -(days - 1)), from).map(r => ({ ...r, earned: round(r.earned), per_day: round(r.earned / days) }));
}

export function accountRanking(days = 7) {
  const s = getSettings();
  const from = addDays(localDate(Date.now(), s.timezone), -(days - 1));
  return db.prepare(`
    SELECT a.id, COALESCE(a.label, a.email) AS account, a.status,
      COALESCE((SELECT SUM(last_total - first_total) FROM account_daily WHERE account_id = a.id AND date >= ?), 0) AS earned,
      (SELECT COUNT(*) FROM devices WHERE account_id = a.id AND missing = 0 AND status != 'banned') AS devices,
      COALESCE((SELECT SUM(bytes) FROM device_usage WHERE account_id = a.id AND date >= ?), 0) AS bytes
    FROM accounts a ORDER BY earned DESC`).all(from, addDays(usageToday(), -(days - 1))).map(r => ({ ...r, earned: round(r.earned), per_device: r.devices ? round(r.earned / days / r.devices) : 0 }));
}
