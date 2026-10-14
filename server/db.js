import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { hashPassword } from './crypto.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'earnapp.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  pw_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  label TEXT,               -- tên gợi nhớ do người dùng đặt
  note TEXT DEFAULT '',
  group_name TEXT DEFAULT '',
  cookie_enc TEXT NOT NULL,
  proxy TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',     -- running | stopped | banned
  status_mode TEXT NOT NULL DEFAULT 'auto',   -- auto | manual
  auth_state TEXT NOT NULL DEFAULT 'pending', -- pending | ok | expired | error
  last_error TEXT DEFAULT '',
  last_sync_at INTEGER,
  balance REAL DEFAULT 0,
  earnings_total REAL DEFAULT 0,
  joined_at TEXT,
  banned_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,          -- 1 = ngừng đồng bộ
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  uuid TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT,
  country TEXT,
  rate REAL,
  earned REAL DEFAULT 0,
  earned_total REAL DEFAULT 0,
  uptime INTEGER DEFAULT 0,
  total_uptime INTEGER DEFAULT 0,
  ips TEXT DEFAULT '[]',
  banned_reason TEXT,
  banned_ip TEXT,
  online INTEGER DEFAULT 0,
  online_since INTEGER,
  last_online_at INTEGER,
  last_earn_at INTEGER,        -- lần cuối earned_total tăng
  status TEXT DEFAULT 'offline', -- online | idle | offline | banned
  status_changed_at INTEGER,
  alerted TEXT DEFAULT '',     -- trạng thái đã gửi cảnh báo, tránh báo lặp
  missing INTEGER DEFAULT 0,   -- không còn trong acc EarnApp
  first_seen_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);

CREATE TABLE IF NOT EXISTS transactions (
  uuid TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT,
  date TEXT,
  payment_method TEXT,
  payment_date TEXT,
  amount REAL,
  fee REAL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);

-- Thu nhập theo ngày, tính từ chênh lệch earnings_total
CREATE TABLE IF NOT EXISTS account_daily (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  first_total REAL NOT NULL,
  last_total REAL NOT NULL,
  PRIMARY KEY (account_id, date)
);

CREATE TABLE IF NOT EXISTS device_daily (
  uuid TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  date TEXT NOT NULL,
  first_total REAL NOT NULL,
  last_total REAL NOT NULL,
  PRIMARY KEY (uuid, date)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  device_uuid TEXT,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info', -- info | good | warning | critical
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount REAL NOT NULL,          -- VND
  period TEXT NOT NULL DEFAULT 'monthly', -- monthly | once
  date TEXT NOT NULL,            -- YYYY-MM-DD: ngày bắt đầu (monthly) hoặc ngày chi (once)
  end_date TEXT,                 -- monthly: ngày kết thúc (trống = vẫn đang trả)
  note TEXT DEFAULT ''
);
`);

// Số dư theo thời gian (mỗi giờ 1 bản / acc, và mỗi khi có thay đổi bất thường)
db.exec(`
CREATE TABLE IF NOT EXISTS balance_snapshots (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  balance REAL NOT NULL,
  earnings_total REAL NOT NULL,
  PRIMARY KEY (account_id, ts)
);
`);

// Dung lượng (byte) mỗi máy theo ngày. EarnApp chỉ trả 7 ngày nên web tự lưu để giữ lịch sử
db.exec(`
CREATE TABLE IF NOT EXISTS device_usage (
  uuid TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (uuid, date)
);
CREATE INDEX IF NOT EXISTS idx_usage_account_date ON device_usage(account_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_date ON device_usage(date);

-- Dung lượng theo tháng (EarnApp trả 5 tháng gần nhất), month = YYYY-MM
CREATE TABLE IF NOT EXISTS device_usage_monthly (
  uuid TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (uuid, month)
);
`);

// Hẹn giờ rút tiền: mỗi acc 1 lịch
db.exec(`
CREATE TABLE IF NOT EXISTS withdraw_schedules (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'weekly',  -- once: rút 1 lần | weekly: lặp lại hằng tuần
  run_date TEXT,                        -- once: YYYY-MM-DD
  weekdays TEXT NOT NULL DEFAULT '',    -- weekly: các thứ, 0 = CN, VD "3" hoặc "1,4"
  time TEXT NOT NULL,                   -- HH:MM theo múi giờ cài đặt
  method TEXT NOT NULL,                 -- paypal.com | wise.com | amazon...
  email TEXT NOT NULL,                  -- email nhận tiền
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,  -- số lần đã thử lại do lỗi mạng
  last_run_at INTEGER,
  last_status TEXT,                     -- ok | failed | skipped | retry | missed
  last_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS withdraw_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  amount REAL,
  method TEXT,
  email TEXT,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdraw_log_ts ON withdraw_log(ts);
`);

// Thêm cột cho DB tạo từ bản cũ
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('accounts', 'suspect_reason', "TEXT NOT NULL DEFAULT ''"); // nghi bị khoá: lý do
addColumn('accounts', 'suspect_at', 'INTEGER');
addColumn('accounts', 'suspect_ack', 'INTEGER NOT NULL DEFAULT 0'); // người dùng bấm "không phải bị khoá"
addColumn('accounts', 'backoff_until', 'INTEGER');                  // bị giới hạn: tạm ngừng gọi tới lúc này
addColumn('accounts', 'backoff_level', 'INTEGER NOT NULL DEFAULT 0');
addColumn('accounts', 'usage_monthly_at', 'INTEGER'); // lần cuối lấy dung lượng theo tháng
addColumn('accounts', 'next_sync_at', 'INTEGER');
addColumn('device_daily', 'check_n', 'INTEGER NOT NULL DEFAULT 0');  // số lần kiểm tra trong ngày
addColumn('device_daily', 'online_n', 'INTEGER NOT NULL DEFAULT 0');  // số lần thấy online -> uptime %
addColumn('accounts', 'empty_status_streak', 'INTEGER NOT NULL DEFAULT 0'); // số lần liên tiếp EarnApp trả trạng thái máy rỗng
addColumn('accounts', 'error_streak', 'INTEGER NOT NULL DEFAULT 0');  // số lần lấy dữ liệu lỗi liên tiếp (mạng, proxy…)
addColumn('accounts', 'archived_at', 'INTEGER');
addColumn('accounts', 'redeem_details', 'TEXT'); // Auto-redeem cài trên EarnApp: JSON {email, payment_method}, '' = chưa cài, NULL = chưa biết
addColumn('users', 'session_ver', 'INTEGER NOT NULL DEFAULT 0'); // tăng lên thì mọi phiên đăng nhập cũ hết hiệu lực                      // đã lưu trữ: ngừng theo dõi nhưng giữ số liệu

// Tên acc luôn là email đăng ký lấy từ EarnApp: bỏ tên tự đặt của bản cũ
db.exec('UPDATE accounts SET label = NULL WHERE label IS NOT NULL');

// Bỏ chế độ chỉnh tay Running/Stopped (bản cũ): đưa về tự động theo máy
{
  const manual = db.prepare("SELECT id FROM accounts WHERE status_mode = 'manual' AND status != 'banned'").all();
  for (const { id } of manual) {
    const active = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND missing = 0 AND status IN ('online', 'idle')").get(id).n;
    db.prepare("UPDATE accounts SET status_mode = 'auto', status = ? WHERE id = ?").run(active > 0 ? 'running' : 'stopped', id);
  }
}

const DEFAULT_SETTINGS = {
  sync_min_min: 5,             // mỗi acc lấy dữ liệu ngẫu nhiên từ 5...
  sync_max_min: 10,            // ...đến 10 phút/lần
  account_delay_sec: 3,        // khoảng cách tối thiểu giữa 2 acc
  idle_hours: 3,               // online mà không ra tiền quá N giờ -> vàng
  offline_grace_min: 10,       // offline quá N phút mới báo
  timezone: 'Asia/Ho_Chi_Minh',
  usd_vnd: 26000,
  telegram_token: '',
  telegram_chat_id: '',
  notify_offline: true,
  notify_online: false,
  notify_idle: true,
  notify_device_banned: true,
  notify_account_banned: true,
  notify_auth: true,
  notify_payout: true,
  notify_suspect: true,
  notify_rate_limit: true,
  notify_sync_error: true,
  notify_withdraw: true,
  error_alert_count: 3,        // lỗi lấy dữ liệu N lần liên tiếp thì báo
  daily_report: true,
  daily_report_hour: 21,
  last_daily_report: '',
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = JSON.parse(r.value);
  return s;
}

export function setSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  }
}

export function addEvent({ account_id = null, device_uuid = null, type, level = 'info', message }) {
  db.prepare('INSERT INTO events(ts, account_id, device_uuid, type, level, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), account_id, device_uuid, type, level, message);
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Tạo tài khoản admin lần đầu
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  db.prepare('INSERT INTO users(username, pw_hash) VALUES (?, ?)').run(config.adminUser, hashPassword(config.adminPassword));
}
