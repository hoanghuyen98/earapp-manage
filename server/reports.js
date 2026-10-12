import { db, getSettings } from './db.js';
import { localDate, addDays, usageToday } from './stats.js';

// Số liệu cho trang Tổng quan và Báo cáo, lọc được theo tài khoản / nhóm / khoảng thời gian

const round = (n, d = 3) => Math.round((n || 0) * 10 ** d) / 10 ** d;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;

/** Danh sách id acc trong phạm vi lọc; null = tất cả */
export function scopeIds(q = {}) {
  let ids = null;
  if (q.acc) ids = String(q.acc).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (q.group) {
    const g = db.prepare('SELECT id FROM accounts WHERE group_name = ?').all(String(q.group)).map(r => r.id);
    ids = ids ? ids.filter(i => g.includes(i)) : g;
  }
  return ids;
}

// id đã được ép kiểu số nguyên nên nhúng thẳng vào SQL an toàn
const inScope = (ids, col = 'account_id') => ids ? (ids.length ? `${col} IN (${ids.join(',')})` : '0') : '1';

function earnRange(ids, from, to, accountId) {
  const w = accountId ? `account_id = ${Number(accountId)}` : inScope(ids);
  return db.prepare(`SELECT COALESCE(SUM(last_total - first_total), 0) AS v FROM account_daily WHERE ${w} AND date >= ? AND date <= ?`).get(from, to).v;
}

function usageRange(ids, from, to) {
  return db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS v FROM device_usage WHERE ${inScope(ids)} AND date >= ? AND date <= ?`).get(from, to).v;
}

function uptimeRange(ids, from, to) {
  const r = db.prepare(`SELECT SUM(dd.online_n) AS o, SUM(dd.check_n) AS c FROM device_daily dd JOIN devices d ON d.uuid = dd.uuid
    WHERE ${inScope(ids, 'd.account_id')} AND dd.date >= ? AND dd.date <= ?`).get(from, to);
  return r.c ? r.o / r.c : null;
}

/** Số ngày có dữ liệu thu nhập trong khoảng (tránh chia trung bình cho cả những ngày chưa theo dõi) */
function dataDays(ids, from, to) {
  return db.prepare(`SELECT COUNT(DISTINCT date) AS n FROM account_daily WHERE ${inScope(ids)} AND date >= ? AND date <= ?`).get(from, to).n;
}

function nameOf(a) { return a.label || a.email || `Acc #${a.id}`; }

/** $/giờ hiện tại: so tổng kiếm bây giờ với bản lưu số dư cách đây 6 giờ (tối thiểu 3 giờ).
 *  EarnApp cộng tiền theo đợt (~1 giờ/lần) nên khoảng ngắn hơn sẽ bị phóng đại. */
function hourlyRate(accounts) {
  const now = Date.now();
  let rate = 0, measured = 0;
  for (const a of accounts) {
    if (a.status === 'banned' || a.suspect_reason || a.paused) continue;
    const snapAt = h => db.prepare('SELECT ts, earnings_total FROM balance_snapshots WHERE account_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(a.id, now - h * 3600e3);
    const snap = snapAt(6) || snapAt(3);
    if (!snap) continue;
    const hours = (now - snap.ts) / 3600e3;
    if (hours <= 0) continue;
    rate += Math.max(0, a.earnings_total - snap.earnings_total) / hours;
    measured++;
  }
  return measured ? rate : null;
}

/** Chuỗi theo ngày, kèm tách theo tài khoản (top 5 + "Khác") */
function dailyByAccount(ids, from, to, accounts) {
  const n = daysBetween(from, to);
  const dates = Array.from({ length: n }, (_, i) => addDays(from, i));
  const rows = db.prepare(`SELECT account_id, date, last_total - first_total AS v FROM account_daily WHERE ${inScope(ids)} AND date >= ? AND date <= ?`).all(from, to);
  const totals = {};
  for (const r of rows) totals[r.account_id] = (totals[r.account_id] || 0) + r.v;
  const top = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => Number(id));
  const byId = Object.fromEntries(accounts.map(a => [a.id, a]));
  const series = top.map(id => ({ key: 'a' + id, name: byId[id] ? nameOf(byId[id]) : `#${id}` }));
  const hasOther = Object.keys(totals).some(id => !top.includes(Number(id)) && totals[id] > 0);
  if (hasOther) series.push({ key: 'other', name: 'Các acc khác' });
  const map = Object.fromEntries(dates.map(d => [d, { date: d, value: 0 }]));
  for (const r of rows) {
    const p = map[r.date];
    if (!p) continue;
    const key = top.includes(r.account_id) ? 'a' + r.account_id : 'other';
    p[key] = round((p[key] || 0) + r.v);
    p.value = round(p.value + r.v);
  }
  return { data: dates.map(d => map[d]), series };
}

function usageDaily(ids, from, to) {
  const n = daysBetween(from, to);
  const rows = db.prepare(`SELECT date, SUM(bytes) AS v FROM device_usage WHERE ${inScope(ids)} AND date >= ? AND date <= ? GROUP BY date`).all(from, to);
  const map = Object.fromEntries(rows.map(r => [r.date, r.v]));
  return Array.from({ length: n }, (_, i) => { const date = addDays(from, i); return { date, value: map[date] || 0 }; });
}

/** Bảng theo tài khoản (dùng chung cho Tổng quan) */
function accountRows(ids, today) {
  const accounts = db.prepare(`SELECT * FROM accounts WHERE ${inScope(ids, 'id')} ORDER BY id`).all();
  const uDay = usageToday();
  const d7 = addDays(today, -6);
  return accounts.map(a => {
    const dev = db.prepare(`SELECT
        SUM(status = 'online') AS online, SUM(status = 'idle') AS idle, SUM(status = 'offline') AS offline, SUM(status = 'banned') AS banned, COUNT(*) AS total
      FROM devices WHERE account_id = ? AND missing = 0`).get(a.id);
    const up = db.prepare(`SELECT SUM(dd.online_n) AS o, SUM(dd.check_n) AS c FROM device_daily dd JOIN devices d ON d.uuid = dd.uuid
      WHERE d.account_id = ? AND dd.date = ?`).get(a.id, today);
    const tx = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
      COALESCE(SUM(CASE WHEN status != 'paid' THEN amount END), 0) AS pending FROM transactions WHERE account_id = ?`).get(a.id);
    return {
      id: a.id, name: nameOf(a), email: a.email, label: a.label, group: a.group_name || '', status: a.status,
      auth_state: a.auth_state, suspect: !!a.suspect_reason, limited: a.backoff_until > Date.now(), paused: !!a.paused,
      dev_total: dev.total || 0, dev_online: dev.online || 0, dev_idle: dev.idle || 0, dev_offline: dev.offline || 0, dev_banned: dev.banned || 0,
      today: round(earnRange(null, today, today, a.id)), d7: round(earnRange(null, d7, today, a.id)),
      usage_today: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS v FROM device_usage WHERE account_id = ? AND date = ?').get(a.id, uDay).v,
      uptime_today: up.c ? up.o / up.c : null,
      balance: a.balance, lifetime: a.earnings_total, withdrawn: tx.paid, pending: tx.pending,
      last_sync_at: a.last_sync_at, next_sync_at: a.next_sync_at,
    };
  });
}

function groupRows(rows, keys) {
  const map = new Map();
  for (const r of rows) {
    const g = r.group || 'Chưa có nhóm';
    if (!map.has(g)) map.set(g, { group: g, accounts: 0 });
    const t = map.get(g);
    t.accounts++;
    for (const k of keys) t[k] = (t[k] || 0) + (r[k] || 0);
  }
  return [...map.values()];
}

/** Việc cần xử lý: gom theo loại, kèm acc và máy */
function attention(ids) {
  const now = Date.now();
  const out = [];
  const accs = db.prepare(`SELECT * FROM accounts WHERE ${inScope(ids, 'id')}`).all();
  for (const a of accs) {
    if (a.suspect_reason) out.push({ type: 'suspect', level: 'critical', account_id: a.id, account: nameOf(a), detail: a.suspect_reason });
    if (a.auth_state === 'expired') out.push({ type: 'auth', level: 'warning', account_id: a.id, account: nameOf(a), detail: 'Cookie hết hạn, cần dán cookie mới' });
    if (a.auth_state === 'error') out.push({ type: 'error', level: 'warning', account_id: a.id, account: nameOf(a), detail: a.last_error });
    if (a.backoff_until > now) out.push({ type: 'limited', level: 'info', account_id: a.id, account: nameOf(a), detail: 'EarnApp đang giới hạn truy cập, web tự thử lại' });
  }
  const devs = db.prepare(`SELECT d.*, a.label, a.email, a.id AS aid FROM devices d JOIN accounts a ON a.id = d.account_id
    WHERE ${inScope(ids, 'd.account_id')} AND d.missing = 0 AND a.paused = 0 AND a.status != 'banned'
      AND ((d.status = 'offline' AND d.last_online_at IS NOT NULL) OR d.status = 'idle' OR (d.status = 'banned' AND d.status_changed_at > ?))
    ORDER BY d.status_changed_at DESC`).all(now - 864e5);
  const groups = {};
  for (const d of devs) {
    const k = d.status + ':' + d.aid;
    groups[k] ??= { type: 'device_' + d.status, level: d.status === 'banned' ? 'critical' : 'warning', account_id: d.aid, account: nameOf({ ...d, id: d.aid }), devices: [], since: d.status_changed_at };
    groups[k].devices.push(d.title);
  }
  out.push(...Object.values(groups));
  const order = { critical: 0, warning: 1, info: 2 };
  return out.sort((x, y) => order[x.level] - order[y.level]);
}

export function overview(q = {}) {
  const s = getSettings();
  const ids = scopeIds(q);
  const now = Date.now();
  const today = localDate(now, s.timezone);
  const yesterday = addDays(today, -1);
  const monthStart = today.slice(0, 8) + '01';
  const [y, m] = today.split('-').map(Number);
  const prevMonthStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const prevMonthSameDay = addDays(prevMonthStart, Number(today.slice(8)) - 1);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = Math.min(Math.max(Number(q.days) || 30, 7), 365);
  const from = addDays(today, -(days - 1));

  const accounts = db.prepare(`SELECT * FROM accounts WHERE ${inScope(ids, 'id')}`).all();
  const sum = (f, pred = () => true) => accounts.filter(pred).reduce((t, a) => t + (Number(f(a)) || 0), 0);
  const tx = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
      COALESCE(SUM(CASE WHEN status != 'paid' THEN amount END), 0) AS pending, SUM(status != 'paid') AS pending_n
    FROM transactions WHERE ${inScope(ids)}`).get();
  const dev = db.prepare(`SELECT SUM(status = 'online') AS online, SUM(status = 'idle') AS idle, SUM(status = 'offline') AS offline,
      SUM(status = 'banned') AS banned FROM devices WHERE ${inScope(ids)} AND missing = 0`).get();

  const earnToday = earnRange(ids, today, today);
  const earnYesterday = earnRange(ids, yesterday, yesterday);
  const earnMonth = earnRange(ids, monthStart, today);
  const earnPrevMonthToDate = earnRange(ids, prevMonthStart, prevMonthSameDay);
  const earnPrevMonth = earnRange(ids, prevMonthStart, addDays(monthStart, -1));

  // Dự báo: hôm nay = đã kiếm + tốc độ hiện tại × số giờ còn lại; tháng = TB 7 ngày gần nhất × số ngày còn lại
  const rate = hourlyRate(accounts);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const hoursLeft = Math.max(0, 24 - (parts.hour % 24) - parts.minute / 60);
  const forecastToday = rate != null ? earnToday + rate * hoursLeft : null;
  const d7from = addDays(today, -7);
  // Ngày đầu tiên theo dõi thường thiếu (bắt đầu giữa ngày) nên bỏ ra; cần ít nhất 2 ngày đủ số liệu
  const firstDay = db.prepare(`SELECT MIN(date) AS d FROM account_daily WHERE ${inScope(ids)}`).get().d;
  const fullFrom = firstDay && firstDay >= d7from ? addDays(firstDay, 1) : d7from;
  const fullDays = fullFrom <= yesterday ? dataDays(ids, fullFrom, yesterday) : 0;
  const avgDaily = fullDays >= 2 ? earnRange(ids, fullFrom, yesterday) / fullDays : (rate != null ? rate * 24 : null);
  const daysLeft = daysInMonth - Number(today.slice(8));
  const forecastMonth = avgDaily != null ? earnMonth - earnToday + (forecastToday ?? earnToday) + avgDaily * daysLeft : null;

  const uDay = usageToday();
  const monthlyUsage = db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS v FROM device_usage_monthly WHERE ${inScope(ids)} AND month = ?`).get(uDay.slice(0, 7)).v;

  const rows = accountRows(ids, today);
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))].length
    ? groupRows(rows, ['dev_total', 'dev_online', 'dev_idle', 'dev_offline', 'dev_banned', 'today', 'd7', 'usage_today', 'balance', 'lifetime', 'withdrawn', 'pending'])
    : [];

  return {
    scope: { ids, all: ids == null },
    lifetime: round(sum(a => a.earnings_total), 2),
    current: round(sum(a => a.balance, a => a.status !== 'banned'), 2),
    banned: round(sum(a => a.balance, a => a.status === 'banned'), 2),
    withdrawn: round(tx.paid, 2), pending: round(tx.pending, 2), pending_count: tx.pending_n || 0,
    today: round(earnToday), yesterday: round(earnYesterday),
    month: round(earnMonth), prev_month_to_date: round(earnPrevMonthToDate), prev_month: round(earnPrevMonth),
    rate_per_hour: rate == null ? null : round(rate, 4),
    forecast_today: forecastToday == null ? null : round(forecastToday),
    forecast_month: forecastMonth == null ? null : round(forecastMonth, 2),
    avg_daily: avgDaily == null ? null : round(avgDaily),
    usage_today: usageRange(ids, uDay, uDay), usage_yesterday: usageRange(ids, addDays(uDay, -1), addDays(uDay, -1)),
    usage_7d: usageRange(ids, addDays(uDay, -6), uDay), usage_month: monthlyUsage || usageRange(ids, uDay.slice(0, 8) + '01', uDay),
    uptime_today: uptimeRange(ids, today, today),
    devices: { online: dev.online || 0, idle: dev.idle || 0, offline: dev.offline || 0, banned: dev.banned || 0 },
    accounts: {
      total: accounts.length,
      running: accounts.filter(a => a.status === 'running').length,
      stopped: accounts.filter(a => a.status === 'stopped').length,
      banned: accounts.filter(a => a.status === 'banned').length,
    },
    days, daily: dailyByAccount(ids, from, today, accounts), usage_daily: usageDaily(ids, addDays(uDay, -(days - 1)), uDay),
    rows, groups,
    attention: attention(ids),
    events: db.prepare(`SELECT e.*, COALESCE(a.label, a.email) AS account FROM events e LEFT JOIN accounts a ON a.id = e.account_id
      WHERE ${ids ? inScope(ids, 'e.account_id') : '1'} ORDER BY e.id DESC LIMIT 12`).all(),
    usd_vnd: s.usd_vnd,
    data_since: db.prepare('SELECT MIN(date) AS d FROM account_daily').get().d,
  };
}

/** Chi phí phân bổ vào khoảng ngày: chi phí tháng chia theo số ngày, chi phí 1 lần tính nếu rơi vào khoảng */
function costInRange(from, to) {
  let total = 0;
  for (const c of db.prepare('SELECT * FROM costs').all()) {
    if (c.period === 'once') { if (c.date >= from && c.date <= to) total += c.amount; continue; }
    const start = c.date > from ? c.date : from;
    const end = c.end_date && c.end_date < to ? c.end_date : to;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const [yy, mm] = d.split('-').map(Number);
      total += c.amount / new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    }
  }
  return total;
}

export function report(q = {}) {
  const s = getSettings();
  const ids = scopeIds(q);
  const today = localDate(Date.now(), s.timezone);
  let to = isDate(q.to) ? q.to : today;
  let from = isDate(q.from) ? q.from : addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) > 400) from = addDays(to, -399);
  const days = daysBetween(from, to);
  const pFrom = addDays(from, -days), pTo = addDays(from, -1);

  const earned = earnRange(ids, from, to);
  const usage = usageRange(ids, from, to);
  const nData = dataDays(ids, from, to);
  const paid = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS n FROM transactions
    WHERE ${inScope(ids)} AND status = 'paid' AND substr(payment_date, 1, 10) >= ? AND substr(payment_date, 1, 10) <= ?`).get(from, to);
  const scopeAll = ids == null;
  const cost = scopeAll ? costInRange(from, to) : null;

  // Theo ngày
  const er = db.prepare(`SELECT date, SUM(last_total - first_total) AS v FROM account_daily WHERE ${inScope(ids)} AND date >= ? AND date <= ? GROUP BY date`).all(from, to);
  const ur = db.prepare(`SELECT date, SUM(bytes) AS v FROM device_usage WHERE ${inScope(ids)} AND date >= ? AND date <= ? GROUP BY date`).all(from, to);
  const em = Object.fromEntries(er.map(r => [r.date, r.v])), um = Object.fromEntries(ur.map(r => [r.date, r.v]));
  const daily = Array.from({ length: days }, (_, i) => { const d = addDays(from, i); return { date: d, value: round(em[d]), usage: um[d] || 0 }; });

  // Theo tài khoản
  const accs = db.prepare(`SELECT * FROM accounts WHERE ${inScope(ids, 'id')} ORDER BY id`).all();
  const accounts = accs.map(a => {
    const one = [a.id];
    const e = earnRange(one, from, to);
    const u = usageRange(one, from, to);
    const active = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND missing = 0 AND status != 'banned'").get(a.id).n;
    const nd = dataDays(one, from, to);
    const p = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM transactions WHERE account_id = ? AND status = 'paid'
      AND substr(payment_date, 1, 10) >= ? AND substr(payment_date, 1, 10) <= ?`).get(a.id, from, to).v;
    return {
      id: a.id, name: nameOf(a), email: a.email, group: a.group_name || '', status: a.status,
      earned: round(e), prev_earned: round(earnRange(one, pFrom, pTo)), usage: u, per_gb: u > 1e8 ? round(e / (u / 1e9)) : null,
      devices: active, per_device_day: active && nd ? round(e / nd / active, 4) : null, uptime: uptimeRange(one, from, to),
      payouts: round(p, 2), balance: a.balance, lifetime: a.earnings_total, share: earned > 0 ? e / earned : 0,
    };
  });
  const groups = [...new Set(accounts.map(a => a.group).filter(Boolean))].length
    ? groupRows(accounts, ['earned', 'prev_earned', 'usage', 'devices', 'payouts', 'balance', 'lifetime']).map(g => ({ ...g, per_gb: g.usage > 1e8 ? round(g.earned / (g.usage / 1e9)) : null, share: earned > 0 ? g.earned / earned : 0 }))
    : [];

  // Theo tháng (12 tháng gần nhất)
  const [y, m] = to.split('-').map(Number);
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(y, m - 1 - (11 - i), 1)).toISOString().slice(0, 7)).map(ym => {
    const mStart = ym + '-01';
    const mEnd = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).toISOString().slice(0, 10);
    const e = earnRange(ids, mStart, mEnd);
    const um2 = db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS v FROM device_usage_monthly WHERE ${inScope(ids)} AND month = ?`).get(ym).v || usageRange(ids, mStart, mEnd);
    const p = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM transactions WHERE ${inScope(ids)} AND status = 'paid' AND substr(payment_date, 1, 7) = ?`).get(ym).v;
    const c = scopeAll ? costInRange(mStart, mEnd) : null;
    return { month: ym, earned: round(e, 2), usage: um2, payouts: round(p, 2), cost_vnd: c == null ? null : Math.round(c), profit_vnd: c == null ? null : Math.round(e * s.usd_vnd - c), has_data: dataDays(ids, mStart, mEnd) > 0 };
  });

  // Theo máy
  const devices = db.prepare(`SELECT d.uuid, d.title, d.status, d.country, a.id AS account_id, COALESCE(a.label, a.email) AS account,
      COALESCE(SUM(dd.last_total - dd.first_total), 0) AS earned, SUM(dd.online_n) AS o, SUM(dd.check_n) AS c,
      COALESCE((SELECT SUM(bytes) FROM device_usage u WHERE u.uuid = d.uuid AND u.date >= ? AND u.date <= ?), 0) AS usage
    FROM devices d JOIN accounts a ON a.id = d.account_id
    LEFT JOIN device_daily dd ON dd.uuid = d.uuid AND dd.date >= ? AND dd.date <= ?
    WHERE ${inScope(ids, 'd.account_id')} AND d.missing = 0
    GROUP BY d.uuid ORDER BY earned DESC`).all(from, to, from, to)
    .map(r => ({ uuid: r.uuid, title: r.title, status: r.status, country: r.country, account_id: r.account_id, account: r.account,
      earned: round(r.earned), usage: r.usage, per_gb: r.usage > 1e8 ? round(r.earned / (r.usage / 1e9)) : null,
      per_day: nData ? round(r.earned / nData, 4) : 0, uptime: r.c ? r.o / r.c : null }));

  // Theo quốc gia
  const cmap = {};
  for (const d of devices) {
    const k = d.country ? d.country.toUpperCase() : 'Không rõ';
    cmap[k] ??= { country: k, devices: 0, active: 0, earned: 0, usage: 0 };
    cmap[k].devices++;
    if (d.status === 'online' || d.status === 'idle') cmap[k].active++;
    cmap[k].earned += d.earned;
    cmap[k].usage += d.usage;
  }
  const countries = Object.values(cmap).map(c => ({ ...c, earned: round(c.earned), per_gb: c.usage > 1e8 ? round(c.earned / (c.usage / 1e9)) : null })).sort((a, b) => b.earned - a.earned);

  return {
    from, to, days, prev: { from: pFrom, to: pTo }, scope_all: scopeAll,
    summary: {
      earned: round(earned), prev_earned: round(earnRange(ids, pFrom, pTo)),
      usage, prev_usage: usageRange(ids, pFrom, pTo), per_gb: usage > 1e8 ? round(earned / (usage / 1e9)) : null,
      avg_per_day: nData ? round(earned / nData) : 0, data_days: nData,
      uptime: uptimeRange(ids, from, to), payouts: round(paid.v, 2), payouts_count: paid.n,
      cost_vnd: cost == null ? null : Math.round(cost), income_vnd: Math.round(earned * s.usd_vnd),
      profit_vnd: cost == null ? null : Math.round(earned * s.usd_vnd - cost),
    },
    daily, accounts, groups, months, devices, countries,
    costs: db.prepare('SELECT * FROM costs ORDER BY date DESC').all(),
    usd_vnd: s.usd_vnd,
    data_since: db.prepare('SELECT MIN(date) AS d FROM account_daily').get().d,
  };
}

/** Danh sách acc + nhóm cho bộ lọc */
export function scopeOptions() {
  return {
    accounts: db.prepare('SELECT id, label, email, group_name, status FROM accounts ORDER BY id').all().map(a => ({ id: a.id, name: nameOf(a), email: a.email, group: a.group_name || '', status: a.status })),
    groups: db.prepare("SELECT DISTINCT group_name AS g FROM accounts WHERE group_name != '' ORDER BY g").all().map(r => r.g),
  };
}
