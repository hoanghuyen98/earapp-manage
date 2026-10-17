import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Users, Download, HardDrive, X, KeyRound, PauseCircle, ChevronRight, HelpCircle, CheckCircle2, XCircle, ShieldAlert, Hourglass, Archive, Loader2 } from 'lucide-react';
import { api, usd, timeAgo, fmtBytes, fmtDateTime, explainError } from '../lib';
import { MachineSelect, MachineModal, MoveModal, MachineActions, NO_MACHINE } from './Machines';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Modal, Field, Input, Textarea, Empty, AccountBadge, StatusDot, StateText, AccName, byAccount, useData, useToast, cx } from '../ui';

/** Acc lâu không lấy được dữ liệu: không hiện Running/Stopped cũ mà ghi "Chưa rõ" */
export function AccountState({ a }) {
  if (a.stale && a.status !== 'banned') {
    return <StateText dot="bg-zinc-300 dark:bg-zinc-600" label="Chưa rõ" className="text-zinc-500" title={`Không lấy được dữ liệu mới từ ${fmtDateTime(a.last_ok_at)}. ${explainError(a.last_error)}`} />;
  }
  return <AccountBadge status={a.status} />;
}

/** "5 phút trước", hoặc đỏ "Dữ liệu cũ từ ..." khi lâu không lấy được */
export function UpdatedAt({ a }) {
  if (!a.last_sync_at && !a.archived_at) return <span className="text-indigo-600 dark:text-indigo-400">Đang tải lần đầu…</span>;
  if (a.stale) return <span className="text-bad" title={explainError(a.last_error)}>Cũ từ {a.last_ok_at ? fmtDateTime(a.last_ok_at) : '—'}</span>;
  return timeAgo(a.last_ok_at || a.last_sync_at);
}

function DeviceCounts({ a }) {
  const items = [['online', a.dev_online], ['idle', a.dev_idle], ['offline', a.dev_offline], ['banned', a.dev_banned], ['unknown', a.dev_unknown]].filter(([, n]) => n > 0);
  if (!items.length) return <span className="whitespace-nowrap text-xs text-zinc-400">Chưa có node</span>;
  return (
    <div className="flex items-center gap-2.5">
      {items.map(([k, n]) => <span key={k} className="inline-flex items-center gap-1 text-[13px] tabular"><StatusDot status={k} size="sm" />{n}</span>)}
    </div>
  );
}

// Tổng của 1 máy (dùng cho dòng tiêu đề máy trong bảng)
const DEV_KEYS = ['dev_online', 'dev_idle', 'dev_offline', 'dev_banned', 'dev_unknown'];
const SUM_KEYS = [...DEV_KEYS, 'today', 'usage_today', 'balance', 'withdrawn', 'earnings_total'];
function machineSum(accs) {
  const t = Object.fromEntries(SUM_KEYS.map(k => [k, 0]));
  for (const a of accs) for (const k of SUM_KEYS) t[k] += a[k] || 0;
  return t;
}

/**
 * Chia acc (đã xếp theo máy) thành từng máy: [{ name, machine, accs, sum }].
 * withEmpty: thêm cả máy chưa có acc (khi không lọc), để thấy và thêm acc vào được.
 */
function splitByMachine(list, machines, withEmpty) {
  const out = [];
  for (const a of list) {
    const name = a.group_name || '';
    if (out.at(-1)?.name !== name) out.push({ name, accs: [] });
    out.at(-1).accs.push(a);
  }
  if (withEmpty) for (const m of machines) if (!out.some(x => x.name === m.name)) out.push({ name: m.name, accs: [] });
  out.sort((x, y) => (!x.name - !y.name) || x.name.localeCompare(y.name, 'vi', { numeric: true, sensitivity: 'base' }));
  return out.map(x => ({ ...x, machine: machines.find(m => m.name === x.name) || null, sum: machineSum(x.accs) }));
}

function AuthIcon({ a }) {
  if (a.archived_at) return <span title="Đã lưu trữ"><Archive className="size-4 text-zinc-400" /></span>;
  if (a.suspect_reason) return <span title={'Nghi bị khoá: ' + a.suspect_reason}><ShieldAlert className="size-4 text-red-500" /></span>;
  if (a.backoff_until > Date.now()) return <span title={a.last_error}><Hourglass className="size-4 text-zinc-400" /></span>;
  if (a.paused) return <span title="Đã tạm ngừng đồng bộ"><PauseCircle className="size-4 text-zinc-400" /></span>;
  if (a.auth_state === 'expired') return <span title="Cookie hết hạn"><KeyRound className="size-4 text-amber-500" /></span>;
  if (a.auth_state === 'error') return <span title={a.last_error}><XCircle className="size-4 text-red-500" /></span>;
  return null;
}

export function CookieGuide() {
  return (
    <details className="group rounded-xl bg-indigo-50/60 px-4 py-3 text-[13px] text-zinc-700 dark:bg-indigo-500/5 dark:text-zinc-300">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-indigo-700 dark:text-indigo-300">
        <HelpCircle className="size-4" /> Cách lấy cookie EarnApp
      </summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>Đăng nhập <b>earnapp.com/dashboard</b> bằng Chrome hoặc Firefox.</li>
        <li>Nhấn <b>F12</b>, chọn tab <b>Network</b> (Mạng), rồi nhấn <b>F5</b>.</li>
        <li>Bấm vào một dòng có tên <b>money</b> hoặc <b>devices</b>.</li>
        <li>Ở tab <b>Headers</b>, tìm dòng <b>Cookie</b> trong Request Headers và copy toàn bộ giá trị.</li>
      </ol>
      <p className="mt-2 text-zinc-500">⚠️ Sau khi thêm, <b>đừng bấm Đăng xuất</b> trên EarnApp, vì cookie sẽ mất hiệu lực. Muốn thoát thì chỉ cần đóng tab.</p>
    </details>
  );
}

const SCHEME = /^([a-z0-9]+):\/\//i;
const typeOf = v => { const m = SCHEME.exec(v || ''); return !m ? null : /^socks/i.test(m[1]) ? 'socks5' : m[1].toLowerCase() === 'https' ? 'https' : 'http'; };

/** Proxy: chọn loại HTTP / SOCKS5, ô bên cạnh chỉ cần dán host:port:user:pass. Giá trị trả ra kèm tiền tố, VD socks5://… */
const PROXY_TYPES = [['socks5', 'SOCKS5'], ['http', 'HTTP']];
const DEFAULT_PROXY = 'socks5';
const manyLines = t => /\S\s*\n\s*\S/.test(t);

/**
 * Ô proxy: chọn loại (mặc định SOCKS5) + địa chỉ. Giá trị trả ra luôn kèm loại ở đầu (socks5://…, http://…).
 * compact: dùng trong dòng acc khi thêm nhiều acc (không có nhãn, không có dòng hướng dẫn).
 * onPasteMany: dán nhiều dòng vào ô thì gọi hàm này thay vì điền vào ô.
 */
export function ProxyField({ value, onChange, compact, onPasteMany, id = 'proxy-host' }) {
  const [picked, setPicked] = useState(DEFAULT_PROXY);
  // Giá trị đã có loại ở đầu thì theo loại đó, chưa nhập gì thì theo nút đang chọn
  const type = typeOf(value) || picked;
  const host = String(value || '').replace(SCHEME, '');
  const emit = (t, h) => onChange(h.trim() ? `${t}://${h.trim()}` : '');
  const onHost = v => {
    // Dán cả chuỗi có tiền tố (socks5://…, http://…): tự chọn đúng loại
    const t = typeOf(v);
    if (t) setPicked(t);
    emit(t || type, v.replace(SCHEME, ''));
  };
  const pick = t => { setPicked(t); emit(t, host); };
  const types = type === 'https' ? [...PROXY_TYPES, ['https', 'HTTPS']] : PROXY_TYPES;
  const box = (
    <div className={cx('flex rounded-xl bg-white ring-1 ring-zinc-300/80 focus-within:ring-2 focus-within:ring-indigo-600 dark:bg-zinc-800/60 dark:ring-zinc-700 dark:focus-within:ring-indigo-400', compact ? 'h-[38px]' : 'h-9')}>
      <div role="radiogroup" aria-label="Loại proxy" className="flex shrink-0 items-center gap-0.5 rounded-l-xl border-r border-zinc-200 bg-zinc-50 px-1 dark:border-zinc-700 dark:bg-zinc-800">
        {types.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={type === k} onClick={() => pick(k)}
            className={cx('rounded-lg font-semibold tracking-wide transition cursor-pointer', compact ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2.5 text-xs',
              type === k ? 'bg-indigo-600 text-white shadow-sm dark:bg-indigo-400 dark:text-indigo-950' : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-200')}>
            {l}
          </button>
        ))}
      </div>
      <input id={id} value={host} onChange={e => onHost(e.target.value)} placeholder={compact ? 'host:port:user:pass' : '1.2.3.4:1080:user:pass'} spellCheck={false} autoComplete="off"
        onPaste={onPasteMany && (e => { const t = e.clipboardData.getData('text'); if (manyLines(t)) { e.preventDefault(); onPasteMany(t, type); } })}
        className="min-w-0 flex-1 border-0 bg-transparent px-2.5 font-mono text-xs placeholder:text-zinc-400 focus:outline-none" />
    </div>
  );
  if (compact) return box;
  // Không bọc trong <label>: bấm chữ "Proxy" không được tự bấm nút loại proxy
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">Proxy</label>
      {box}
      <span className="mt-1 block text-xs text-zinc-500">Không bắt buộc. Dán dạng host:port:user:pass hoặc user:pass@host:port</span>
    </div>
  );
}

const fmtEta = sec => sec == null ? '' : sec < 60 ? `còn khoảng ${Math.max(5, Math.ceil(sec / 5) * 5)} giây` : `còn khoảng ${Math.ceil(sec / 60)} phút`;

export function ProgressRow({ name, p }) {
  const done = p?.state === 'done', err = p?.state === 'error';
  const pct = done ? 100 : p?.percent || 0;
  return (
    <li className="rounded-xl bg-zinc-50 px-3 py-2.5 text-sm dark:bg-zinc-800/60">
      <div className="flex items-start gap-2.5">
        {done ? <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
          : err ? <XCircle className="size-5 shrink-0 text-red-500" />
          : <Loader2 className="size-5 shrink-0 animate-spin text-indigo-500" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <b className="truncate">{name}</b>
            {!err && <span className="shrink-0 font-medium tabular text-zinc-600 dark:text-zinc-300">{pct}%</span>}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {!p ? 'Đang chờ tới lượt…'
              : done ? `Đã tải xong · ${p.devices} node · số dư ${usd(p.balance)}`
              : err ? <span className="text-bad">{explainError(p.error)}</span>
              : p.state === 'queued' ? <>Đang chờ tới lượt{p.ahead ? ` (còn ${p.ahead} acc trước)` : ''} · {fmtEta(p.eta_sec)}</>
              : <>{p.step}… · {fmtEta(p.eta_sec)}</>}
          </div>
          {!err && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div className={cx('h-full rounded-full transition-[width] duration-700', done ? 'bg-emerald-500' : 'bg-indigo-500')} style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// Tên acc sau: "A1" -> "A2", "VPS-09" -> "VPS-10". Không có số ở cuối thì để trống
const nextLabel = l => {
  const m = String(l || '').match(/^(.*?)(\d+)$/);
  return m ? m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0') : '';
};
const emptyRow = (label = '') => ({ key: Math.random(), cookie: '', label, proxy: '' });

// Dòng acc khi thêm nhiều acc: máy tính 1 hàng (số | cookie | tên | proxy | ✕), điện thoại 3 hàng
const ROW_GRID = 'grid grid-cols-[1.25rem_1fr_1.75rem] gap-x-2 gap-y-1.5 sm:grid-cols-[1.25rem_minmax(0,1fr)_5rem_minmax(0,1.35fr)_1.75rem]';

function AddAccountModal({ open, onClose, onAdded, machine = '' }) {
  const [form, setForm] = useState({ group_name: machine, note: '' });
  const [rows, setRows] = useState(() => [emptyRow()]);
  // Bấm "Thêm acc" ở 1 máy: chọn sẵn máy đó
  useEffect(() => { if (open && machine) setForm(f => ({ ...f, group_name: machine })); }, [open, machine]);
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const filled = rows.filter(r => r.cookie.trim());

  const setRow = (i, patch) => setRows(rs => rs.map((r, k) => k === i ? { ...r, ...patch } : r));
  // Dán nhiều cookie (mỗi dòng 1 cái) vào 1 ô: tự tách ra thành nhiều acc
  const setCookie = (i, v) => {
    const parts = v.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) return setRow(i, { cookie: v });
    setRows(rs => {
      let label = rs[i].label;
      const extra = parts.slice(1).map(c => { label = nextLabel(label); return { ...emptyRow(label), cookie: c }; });
      return [...rs.slice(0, i), { ...rs[i], cookie: parts[0] }, ...extra, ...rs.slice(i + 1)];
    });
  };
  // Dán nhiều proxy (mỗi dòng 1 cái) vào 1 ô: điền xuống các acc bên dưới, thiếu dòng thì thêm acc mới
  const pasteProxies = (i, t, type) => {
    // Dòng chưa ghi loại thì lấy loại đang chọn ở ô vừa dán
    const parts = t.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(x => SCHEME.test(x) ? x : `${type}://${x}`);
    setRows(rs => {
      const out = [...rs];
      parts.forEach((proxy, k) => {
        if (!out[i + k]) out.push(emptyRow(nextLabel(out.at(-1)?.label)));
        out[i + k] = { ...out[i + k], proxy };
      });
      return out;
    });
  };
  const addRow = () => setRows(rs => [...rs, emptyRow(nextLabel(rs.at(-1)?.label))]);
  const removeRow = i => setRows(rs => rs.length > 1 ? rs.filter((_, k) => k !== i) : [emptyRow()]);

  // Gửi xong là đóng: server kiểm tra cookie + tải dữ liệu chạy ngầm, xong thì báo ở thẻ đầu trang và Telegram
  const submit = async () => {
    setLoading(true); setError('');
    const list = filled.map(r => ({ cookie: r.cookie.trim(), label: r.label.trim(), proxy: r.proxy.trim() }));
    try {
      await api('/accounts', { method: 'POST', body: { ...form, rows: list } });
      window.dispatchEvent(new Event('addjobs:refresh'));
      toast(`Đang thêm ${list.length} acc ở nền. Bạn làm việc khác được, xong sẽ báo`);
      onAdded();
      close();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  // Đóng xong giữ máy vừa chọn: thêm tiếp acc cho cùng máy khỏi chọn lại
  const close = () => { setError(''); setRows([emptyRow()]); setForm(f => ({ group_name: f.group_name, note: '' })); onClose(); };
  const n = filled.length;

  return (
    <Modal open={open} onClose={close} wide title={form.group_name ? `Thêm tài khoản vào ${form.group_name}` : 'Thêm tài khoản'} subtitle='Dán cookie của acc. Thêm nhiều acc thì bấm "Thêm acc nữa"'
      footer={<>
        <span className="mr-auto hidden self-center text-xs text-zinc-500 sm:block">Bấm Thêm là xong, web tự kiểm tra và tải dữ liệu ở nền</span>
        <Button variant="secondary" onClick={close}>Huỷ</Button>
        <Button loading={loading} disabled={!n || !form.group_name} title={!form.group_name ? 'Chọn máy trước' : undefined} onClick={submit} icon={Plus}>{n > 1 ? `Thêm ${n} acc` : 'Thêm acc'}</Button>
      </>}>
      <div className="space-y-4">
        {error && <div className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"><XCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
        <Field label="Máy" hint={n > 1 ? `Cả ${n} acc sẽ vào máy này` : 'Acc chạy trên máy nào. Chưa có máy thì tạo ngay tại đây'}>
          <MachineSelect required value={form.group_name} onChange={v => setForm({ ...form, group_name: v })} />
        </Field>
        <CookieGuide />
        <div className="space-y-3">
          {rows.length === 1 ? (
            <div className="space-y-2">
              <Field label="Cookie">
                <Textarea rows={3} value={rows[0].cookie} spellCheck={false} onChange={e => setCookie(0, e.target.value)} placeholder="oauth-refresh-token=1%2F%2F0...; auth=1; ..." className="font-mono text-xs" />
              </Field>
              <Field label="Tên riêng"><Input value={rows[0].label} maxLength={40} onChange={e => setRow(0, { label: e.target.value })} placeholder="VD: A1" /></Field>
              <ProxyField value={rows[0].proxy} onChange={v => setRow(0, { proxy: v })} />
            </div>
          ) : (
            <div className="space-y-3 sm:space-y-2">
              <div className={cx(ROW_GRID, 'hidden px-0.5 text-[13px] font-medium text-zinc-700 sm:grid dark:text-zinc-300')}>
                <span /><span>Cookie</span><span>Tên riêng</span><span>Proxy</span><span />
              </div>
              {rows.map((r, i) => (
                <div key={r.key} className={cx(ROW_GRID, 'items-center')}>
                  <span className="row-span-3 text-right text-xs text-zinc-400 tabular sm:row-span-1">{i + 1}</span>
                  <Input value={r.cookie} spellCheck={false} autoFocus={i > 0 && !r.cookie} onChange={e => setCookie(i, e.target.value)}
                    onPaste={e => { const t = e.clipboardData.getData('text'); if (manyLines(t)) { e.preventDefault(); setCookie(i, t); } }}
                    placeholder="Cookie: oauth-refresh-token=..." className="font-mono text-xs" />
                  <Input value={r.label} maxLength={40} onChange={e => setRow(i, { label: e.target.value })} placeholder="Tên, VD: A1" className="col-start-2 sm:col-start-auto sm:placeholder:text-transparent" />
                  <div className="col-start-2 sm:col-start-auto">
                    <ProxyField compact id={`proxy-${r.key}`} value={r.proxy} onChange={v => setRow(i, { proxy: v })} onPasteMany={(t, type) => pasteProxies(i, t, type)} />
                  </div>
                  <button type="button" onClick={() => removeRow(i)} title="Bỏ acc này" className="col-start-3 row-span-3 row-start-1 justify-self-center rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 sm:col-start-auto sm:row-span-1 sm:row-start-auto dark:hover:bg-zinc-800"><X className="size-4" /></button>
                </div>
              ))}
              <p className="text-xs text-zinc-500">Proxy: chọn SOCKS5 hoặc HTTP, rồi ghi host:port:user:pass hoặc user:pass@host:port. Dán nhiều cookie hoặc nhiều proxy (mỗi dòng 1 cái) vào 1 ô thì tự điền xuống các dòng dưới.</p>
            </div>
          )}
          <button type="button" onClick={addRow}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2.5 text-sm font-medium text-indigo-600 hover:border-indigo-400 hover:bg-indigo-50/50 dark:border-zinc-700 dark:text-indigo-400 dark:hover:bg-indigo-500/5">
            <Plus className="size-4" /> Thêm acc nữa
          </button>
        </div>
        <Field label="Ghi chú" hint={n > 1 ? 'Ghi chú dùng chung cho các acc trên' : null}><Input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="VD: node1 → node20" /></Field>
      </div>
    </Modal>
  );
}

/** Dòng tiêu đề 1 máy trong bảng: tên, ghi chú, tổng của máy, nút quản lý máy */
function MachineHead({ g, mobile, onAdd, onEdit, onMove, onDelete }) {
  const m = g.machine;
  const title = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4 shrink-0 text-zinc-400" />
        {g.name ? <Link to={`/devices?group=${encodeURIComponent(g.name)}`} title="Xem node của máy" className={cx('font-semibold hover:text-indigo-600', mobile ? 'truncate' : 'whitespace-nowrap')}>{g.name}</Link>
          : <span className="font-semibold text-zinc-500">{NO_MACHINE}</span>}
        <span className="shrink-0 text-xs font-normal text-zinc-500">{g.accs.length} acc</span>
      </div>
      {m?.note && <div className="truncate pl-6 text-xs font-normal text-zinc-500">{m.note}</div>}
    </div>
  );
  const actions = m && <MachineActions m={m} onAdd={() => onAdd(m.name)} onEdit={() => onEdit(m)} onMove={() => onMove(m)} onDelete={() => onDelete(m)} />;
  if (mobile) {
    return (
      <li className="space-y-2 bg-zinc-50/80 px-4 py-2.5 text-sm dark:bg-zinc-800/40">
        <div className="flex items-start justify-between gap-2">{title}<span className="shrink-0 font-semibold tabular">{usd(g.sum.balance)}</span></div>
        <div className="flex items-center justify-between gap-2"><DeviceCounts a={g.sum} />{actions}</div>
      </li>
    );
  }
  return (
    <tr className="bg-zinc-50/80 dark:bg-zinc-800/40">
      <td className="px-5 py-2.5" colSpan={2}><div className="flex items-center justify-between gap-3">{title}{actions}</div></td>
      <td className="px-3 py-2.5"><DeviceCounts a={g.sum} /></td>
      <td className="px-3 py-2.5 text-right font-semibold tabular">{usd(g.sum.today, 3)}</td>
      <td className="px-3 py-2.5 text-right font-semibold tabular">{fmtBytes(g.sum.usage_today)}</td>
      <td className="px-3 py-2.5 text-right font-semibold tabular">{usd(g.sum.balance)}</td>
      <td className="px-3 py-2.5 text-right font-semibold tabular">{usd(g.sum.withdrawn)}</td>
      <td className="px-3 py-2.5 text-right font-semibold tabular">{usd(g.sum.earnings_total)}</td>
      <td colSpan={2} />
    </tr>
  );
}

export default function Accounts() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, reload } = useData(() => api('/accounts'), [], 30000);
  const { data: mData, reload: reloadMachines } = useData(() => api('/machines'), [], 30000);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const filter = params.get('filter') || 'all';
  // Đang thêm acc: false, hoặc { machine } = máy chọn sẵn ('' = để người dùng chọn)
  const [adding, setAdding] = useState(params.get('add') === '1' ? { machine: params.get('machine') || '' } : false);
  const [editing, setEditing] = useState(null); // máy đang sửa, hoặc 'new'
  const [moving, setMoving] = useState(null);

  useEffect(() => { if (params.get('add')) { params.delete('add'); params.delete('machine'); setParams(params, { replace: true }); } }, []); // eslint-disable-line

  const machineList = useMemo(() => (mData || []).filter(m => m.id != null), [mData]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter(a =>
      (filter === 'archived' ? !!a.archived_at : !a.archived_at) &&
      (filter === 'all' || filter === 'archived' || (filter === 'auth' ? ['expired', 'error'].includes(a.auth_state) : filter === 'suspect' ? !!a.suspect_reason : a.status === filter)) &&
      (!group || a.group_name === group) &&
      (!s || [a.email, a.label, a.note, a.group_name].some(x => x?.toLowerCase().includes(s))))
      .sort(byAccount);
  }, [data, q, filter, group]);

  // Acc thêm ở nền: có acc mới vào / tải xong thì làm mới danh sách (đặt trước lệnh return sớm: hook phải luôn được gọi)
  useEffect(() => {
    const on = () => { reload(); reloadMachines(); };
    window.addEventListener('accounts:changed', on);
    return () => window.removeEventListener('accounts:changed', on);
  }, []); // eslint-disable-line

  if (loading && !data) return <PageLoading />;
  const reloadAll = () => { reload(); reloadMachines(); };
  const archivedCount = (data || []).filter(a => a.archived_at).length;
  const all = (data || []).filter(a => !a.archived_at);
  const count = k => all.filter(a => a.status === k).length;
  const authCount = all.filter(a => ['expired', 'error'].includes(a.auth_state)).length;
  const suspectCount = all.filter(a => a.suspect_reason).length;
  const noMachine = all.filter(a => !a.group_name).length;
  // Bảng luôn chia theo máy (mỗi máy 1 dòng tiêu đề có tổng + nút quản lý máy). Không lọc thì hiện cả máy chưa có acc.
  const unfiltered = filter === 'all' && !q.trim() && !group;
  const rows = splitByMachine(list, machineList, unfiltered);
  const byMachine = machineList.length > 0;
  const totals = list.reduce((t, a) => ({ life: t.life + a.earnings_total, bal: t.bal + a.balance, wd: t.wd + a.withdrawn }), { life: 0, bal: 0, wd: 0 });
  const delMachine = async m => {
    try { await api(`/machines/${m.id}`, { method: 'DELETE' }); toast(`Đã xoá "${m.name}"`); reloadAll(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const head = (g, mobile) => byMachine && (
    <MachineHead key={'m:' + g.name} g={g} mobile={mobile} onAdd={machine => setAdding({ machine })} onEdit={setEditing} onMove={setMoving} onDelete={delMachine} />
  );
  const emptyMachine = (g, mobile) => !g.accs.length && (mobile
    ? <li key={'e:' + g.name} className="px-4 py-3 text-xs text-zinc-500">Máy chưa có acc.</li>
    : <tr key={'e:' + g.name}><td colSpan={10} className="px-5 py-3 pl-11 text-xs text-zinc-500">Máy chưa có acc. Bấm <b>Thêm acc</b> để thêm acc mới, hoặc nút ⇄ để chuyển acc có sẵn vào.</td></tr>);

  return (
    <>
      <PageHeader title="Máy & tài khoản" subtitle={`${machineList.length} máy · ${all.length} tài khoản`}>
        <a href="/api/export/accounts"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
        <Button variant="secondary" icon={HardDrive} onClick={() => setEditing('new')}>Thêm máy</Button>
        <Button icon={Plus} onClick={() => setAdding({ machine: '' })}>Thêm tài khoản</Button>
      </PageHeader>

      {noMachine > 0 && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          Có <b>{noMachine} acc chưa gán máy</b>. {machineList.length ? 'Bấm nút ⇄ (chuyển acc) ở máy cần gán để đưa acc vào.' : 'Bấm "Thêm máy" để tạo máy, rồi bấm nút ⇄ ở máy đó để đưa acc vào.'}
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={filter} onChange={v => { v === 'all' ? params.delete('filter') : params.set('filter', v); setParams(params, { replace: true }); }} items={[
          { value: 'all', label: 'Tất cả', count: all.length },
          { value: 'running', label: 'Đang chạy', count: count('running'), dot: 'bg-good' },
          { value: 'stopped', label: 'Đã dừng', count: count('stopped'), dot: 'bg-warn' },
          { value: 'banned', label: 'Bị khoá', count: count('banned'), dot: 'bg-bad' },
          ...(suspectCount ? [{ value: 'suspect', label: 'Nghi bị khoá', count: suspectCount, dot: 'bg-bad' }] : []),
          ...(authCount ? [{ value: 'auth', label: 'Cần cookie', count: authCount, dot: 'bg-amber-500' }] : []),
          ...(archivedCount || filter === 'archived' ? [{ value: 'archived', label: 'Lưu trữ', count: archivedCount }] : []),
        ]} />
        <div className="flex gap-2">
          {machineList.length > 0 && (
            <select value={group} onChange={e => setGroup(e.target.value)} className="h-9 rounded-xl border-0 bg-white px-3 text-sm ring-1 ring-inset ring-zinc-300/80 dark:bg-zinc-800/60 dark:ring-zinc-700 cursor-pointer">
              <option value="">Tất cả máy</option>
              {machineList.map(m => <option key={m.id}>{m.name}</option>)}
            </select>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Tìm máy, tên, email, ghi chú…" className="w-full lg:w-72" />
        </div>
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <Empty icon={all.length || filter === 'archived' ? Users : HardDrive} title={all.length || filter === 'archived' ? 'Không có tài khoản phù hợp' : 'Chưa có máy và tài khoản'}>
            {all.length || filter === 'archived' ? null : <>
              Mỗi máy (máy thật hoặc VPS) chạy nhiều acc EarnApp. Tạo máy trước, sau đó thêm tài khoản vào máy.
              <div className="mt-3"><Button icon={HardDrive} onClick={() => setEditing('new')}>Thêm máy đầu tiên</Button></div>
            </>}
          </Empty>
        ) : (
          <>
            {/* Bảng (desktop) */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800">
                    <th className="px-5 py-3 font-medium">{byMachine ? 'Máy / tài khoản' : 'Tài khoản'}</th>
                    <th className="px-3 py-3 font-medium">Trạng thái</th>
                    <th className="px-3 py-3 font-medium">Node</th>
                    <th className="px-3 py-3 text-right font-medium">Hôm nay</th>
                    <th className="px-3 py-3 text-right font-medium">Dung lượng</th>
                    <th className="px-3 py-3 text-right font-medium">Số dư</th>
                    <th className="px-3 py-3 text-right font-medium">Đã rút</th>
                    <th className="px-3 py-3 text-right font-medium">Tổng kiếm</th>
                    <th className="px-3 py-3 font-medium">Cập nhật</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {rows.map(g => [
                    head(g),
                    emptyMachine(g),
                    ...g.accs.map(a => (
                      <tr key={a.id} onClick={() => navigate(`/accounts/${a.id}`)} className="cursor-pointer hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                        <td className={cx('max-w-72 py-3.5 pr-3', byMachine ? 'pl-11' : 'pl-5')}>
                          <AccName label={a.label} email={a.email} group={byMachine ? null : a.group_name} sub={a.note} extra={<AuthIcon a={a} />} />
                        </td>
                        <td className="px-3 py-3.5"><AccountState a={a} /></td>
                        <td className="px-3 py-3.5"><DeviceCounts a={a} /></td>
                        <td className="px-3 py-3.5 text-right tabular">{usd(a.today, 3)}</td>
                        <td className="px-3 py-3.5 text-right text-zinc-600 tabular dark:text-zinc-300">{fmtBytes(a.usage_today)}</td>
                        <td className="px-3 py-3.5 text-right font-medium tabular">{usd(a.balance)}</td>
                        <td className="px-3 py-3.5 text-right tabular">{usd(a.withdrawn)}{a.pending > 0 && <div className="text-xs text-amber-700 dark:text-amber-400">+{usd(a.pending)} chờ</div>}</td>
                        <td className="px-3 py-3.5 text-right tabular">{usd(a.earnings_total)}</td>
                        <td className="px-3 py-3.5 text-xs text-zinc-500 whitespace-nowrap"><UpdatedAt a={a} /></td>
                        <td className="pr-4"><ChevronRight className="size-4 text-zinc-300" /></td>
                      </tr>
                    )),
                  ])}
                </tbody>
                {list.length > 1 && (
                  <tfoot>
                    <tr className="border-t border-zinc-200 text-sm font-semibold dark:border-zinc-700">
                      <td className="px-5 py-3" colSpan={4}>Tổng {list.length} acc{byMachine ? ` · ${rows.filter(g => g.name).length} máy` : ''}</td>
                      <td className="px-3 py-3 text-right tabular">{fmtBytes(list.reduce((s, a) => s + a.usage_today, 0))}</td>
                      <td className="px-3 py-3 text-right tabular">{usd(totals.bal)}</td>
                      <td className="px-3 py-3 text-right tabular">{usd(totals.wd)}</td>
                      <td className="px-3 py-3 text-right tabular">{usd(totals.life)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {/* Thẻ (mobile) */}
            <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
              {rows.map(g => [
                head(g, true),
                emptyMachine(g, true),
                ...g.accs.map(a => (
                  <li key={a.id}>
                    <Link to={`/accounts/${a.id}`} className="block px-4 py-3.5 active:bg-zinc-50 dark:active:bg-zinc-800/40">
                      <div className="flex items-center justify-between gap-3">
                        <AccName label={a.label} email={a.email} group={byMachine ? null : a.group_name} extra={<AuthIcon a={a} />} />
                        <AccountState a={a} />
                      </div>
                      {a.stale && <div className="mt-1 text-xs"><UpdatedAt a={a} /></div>}
                      <div className="mt-2 flex items-center justify-between">
                        <DeviceCounts a={a} />
                        <span className="text-sm font-semibold tabular">{usd(a.balance)}</span>
                      </div>
                      <div className="mt-1 flex justify-between text-xs text-zinc-500">
                        <span>Hôm nay {usd(a.today, 3)} · {fmtBytes(a.usage_today)}</span>
                        <span>Tổng {usd(a.earnings_total)}</span>
                      </div>
                    </Link>
                  </li>
                )),
              ])}
            </ul>
          </>
        )}
      </Card>

      <AddAccountModal open={!!adding} machine={adding?.machine || ''} onClose={() => setAdding(false)} onAdded={reloadAll} />
      {editing && <MachineModal key={editing === 'new' ? 'new' : editing.id} open machine={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reloadAll} />}
      {moving && <MoveModal key={moving.id} open machine={moving} onClose={() => setMoving(null)} onSaved={reloadAll} />}
    </>
  );
}
