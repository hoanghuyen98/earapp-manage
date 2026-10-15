import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Users, Download, KeyRound, PauseCircle, ChevronRight, HelpCircle, CheckCircle2, XCircle, ShieldAlert, Hourglass, Archive, Loader2 } from 'lucide-react';
import { api, usd, timeAgo, fmtBytes, fmtDateTime, explainError } from '../lib';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Modal, Field, Input, Textarea, Empty, AccountBadge, StatusDot, StateText, AccName, byAccount, useData, cx } from '../ui';

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
  if (!items.length) return <span className="text-xs text-zinc-400">Chưa có node</span>;
  return (
    <div className="flex items-center gap-2.5">
      {items.map(([k, n]) => <span key={k} className="inline-flex items-center gap-1 text-[13px] tabular"><StatusDot status={k} size="sm" />{n}</span>)}
    </div>
  );
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
const PROXY_TYPES = [['http', 'HTTP'], ['socks5', 'SOCKS5']];

export function ProxyField({ value, onChange }) {
  const [type, setType] = useState(() => typeOf(value) || 'http');
  const host = String(value || '').replace(SCHEME, '');
  const emit = (t, h) => onChange(h.trim() ? `${t}://${h.trim()}` : '');
  const onHost = v => {
    // Dán cả chuỗi có tiền tố (socks5://…, http://…): tự chọn đúng loại
    const t = typeOf(v);
    if (t) setType(t);
    emit(t || type, v.replace(SCHEME, ''));
  };
  const pick = t => { setType(t); emit(t, host); };
  const types = type === 'https' ? [...PROXY_TYPES, ['https', 'HTTPS']] : PROXY_TYPES;
  // Không bọc trong <label>: bấm chữ "Proxy" không được tự bấm nút loại proxy
  return (
    <div>
      <label htmlFor="proxy-host" className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">Proxy</label>
      <div className="flex h-9 rounded-xl bg-white ring-1 ring-zinc-300/80 focus-within:ring-2 focus-within:ring-indigo-600 dark:bg-zinc-800/60 dark:ring-zinc-700 dark:focus-within:ring-indigo-400">
        <div role="radiogroup" aria-label="Loại proxy" className="flex shrink-0 items-center gap-0.5 rounded-l-xl border-r border-zinc-200 bg-zinc-50 px-1 dark:border-zinc-700 dark:bg-zinc-800">
          {types.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={type === k} onClick={() => pick(k)}
              className={cx('h-7 rounded-lg px-2.5 text-xs font-semibold tracking-wide transition cursor-pointer',
                type === k ? 'bg-indigo-600 text-white shadow-sm dark:bg-indigo-400 dark:text-indigo-950' : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-200')}>
              {l}
            </button>
          ))}
        </div>
        <input id="proxy-host" value={host} onChange={e => onHost(e.target.value)} placeholder="1.2.3.4:1080:user:pass" spellCheck={false} autoComplete="off"
          className="min-w-0 flex-1 border-0 bg-transparent px-3 font-mono text-xs placeholder:text-zinc-400 focus:outline-none" />
      </div>
      <span className="mt-1 block text-xs text-zinc-500">Không bắt buộc. Dán dạng host:port:user:pass hoặc user:pass@host:port</span>
    </div>
  );
}

const fmtEta = sec => sec == null ? '' : sec < 60 ? `còn khoảng ${Math.max(5, Math.ceil(sec / 5) * 5)} giây` : `còn khoảng ${Math.ceil(sec / 60)} phút`;

/** Tiến độ lấy dữ liệu lần đầu của các acc vừa thêm: hỏi server mỗi giây tới khi xong hết */
function useSyncProgress(ids, onAllDone) {
  const [list, setList] = useState([]);
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let stop = false, t;
    const tick = async () => {
      try {
        const r = await api(`/accounts/progress?ids=${key}`);
        if (stop) return;
        setList(r);
        if (r.length && r.every(p => p.state === 'done' || p.state === 'error')) { onAllDone?.(); return; }
      } catch { /* mạng chập chờn: thử lại lần sau */ }
      if (!stop) t = setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
  }, [key]); // eslint-disable-line
  return list;
}

function ProgressRow({ name, p }) {
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

function AddAccountModal({ open, onClose, onAdded }) {
  const [form, setForm] = useState({ cookies: '', label: '', group_name: '', proxy: '', note: '' });
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const lines = form.cookies.split('\n').filter(l => l.trim()).length;
  const okIds = (results || []).filter(r => r.ok).map(r => r.id);
  const progress = useSyncProgress(okIds, onAdded);
  const byId = Object.fromEntries(progress.map(p => [p.id, p]));
  const doneCount = progress.filter(p => p.state === 'done' || p.state === 'error').length;
  const allDone = okIds.length > 0 && doneCount === okIds.length;
  const total = okIds.length ? Math.round(okIds.reduce((s, id) => s + (byId[id]?.state === 'done' || byId[id]?.state === 'error' ? 100 : byId[id]?.percent || 0), 0) / okIds.length) : 0;

  const submit = async () => {
    setLoading(true);
    try {
      const r = await api('/accounts', { method: 'POST', body: form });
      setResults(r.results);
      if (r.results.some(x => x.ok)) onAdded();
    } catch (e) { setResults([{ ok: false, error: e.message }]); } finally { setLoading(false); }
  };
  const close = () => { setResults(null); setForm({ cookies: '', label: '', group_name: '', proxy: '', note: '' }); onClose(); };

  return (
    <Modal open={open} onClose={close} wide title="Thêm tài khoản" subtitle="Mỗi dòng 1 cookie"
      footer={results
        ? <>
            {okIds.length > 0 && !allDone && <span className="mr-auto self-center text-xs text-zinc-500">Đóng cửa sổ vẫn tiếp tục tải ở nền</span>}
            <Button variant={allDone || !okIds.length ? 'primary' : 'secondary'} onClick={close}>{allDone || !okIds.length ? 'Xong' : 'Đóng'}</Button>
          </>
        : <><Button variant="secondary" onClick={close}>Huỷ</Button><Button loading={loading} disabled={!lines} onClick={submit} icon={Plus}>{loading ? `Đang kiểm tra ${lines > 1 ? `${lines} cookie` : 'cookie'}…` : `Thêm ${lines > 1 ? `${lines} tài khoản` : ''}`}</Button></>}>
      {results ? (
        <div className="space-y-3">
          {okIds.length > 1 && (
            <div className="text-sm">
              <div className="flex justify-between"><span className="font-medium">{allDone ? 'Đã tải xong' : 'Đang tải dữ liệu'} {doneCount}/{okIds.length} acc</span><span className="font-medium tabular">{total}%</span></div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div className={cx('h-full rounded-full transition-[width] duration-700', allDone ? 'bg-emerald-500' : 'bg-indigo-500')} style={{ width: `${total}%` }} />
              </div>
            </div>
          )}
          <ul className="space-y-2">
            {results.map((r, i) => r.ok
              ? <ProgressRow key={i} name={<>{form.label && results.length === 1 ? `${form.label} (${r.email})` : r.email}{r.updated && <span className="font-normal text-zinc-500"> · đã cập nhật cookie</span>}</>} p={byId[r.id]} />
              : (
                <li key={i} className="flex items-start gap-2.5 rounded-xl bg-zinc-50 px-3 py-2.5 text-sm dark:bg-zinc-800/60">
                  <XCircle className="size-5 shrink-0 text-red-500" /><span>Lỗi: {r.error}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          <CookieGuide />
          <Field label="Cookie">
            <Textarea rows={4} value={form.cookies} onChange={e => setForm({ ...form, cookies: e.target.value })} placeholder="oauth-refresh-token=1%2F%2F0...; auth=1; ..." className="font-mono text-xs" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tên riêng" hint={lines > 1 ? 'Thêm nhiều acc: đặt tên sau, trong Sửa' : null}>
              <Input value={lines > 1 ? '' : form.label} disabled={lines > 1} maxLength={40} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="VD: A1" />
            </Field>
            <Field label="Máy"><Input value={form.group_name} onChange={e => setForm({ ...form, group_name: e.target.value })} placeholder="VD: VPS-01" /></Field>
          </div>
          <ProxyField value={form.proxy} onChange={v => setForm({ ...form, proxy: v })} />
          <Field label="Ghi chú"><Input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="VD: chạy ở máy nhà anh Tuấn" /></Field>
        </div>
      )}
    </Modal>
  );
}

export default function Accounts() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, loading, reload } = useData(() => api('/accounts'), [], 30000);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const filter = params.get('filter') || 'all';
  const [adding, setAdding] = useState(params.get('add') === '1');

  useEffect(() => { if (params.get('add')) { params.delete('add'); setParams(params, { replace: true }); } }, []); // eslint-disable-line

  const groups = useMemo(() => [...new Set((data || []).map(a => a.group_name).filter(Boolean))], [data]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter(a =>
      (filter === 'archived' ? !!a.archived_at : !a.archived_at) &&
      (filter === 'all' || filter === 'archived' || (filter === 'auth' ? ['expired', 'error'].includes(a.auth_state) : filter === 'suspect' ? !!a.suspect_reason : a.status === filter)) &&
      (!group || a.group_name === group) &&
      (!s || [a.email, a.label, a.note, a.group_name].some(x => x?.toLowerCase().includes(s))))
      .sort(byAccount);
  }, [data, q, filter, group]);

  if (loading && !data) return <PageLoading />;
  const archivedCount = (data || []).filter(a => a.archived_at).length;
  const all = (data || []).filter(a => !a.archived_at);
  const count = k => all.filter(a => a.status === k).length;
  const authCount = all.filter(a => ['expired', 'error'].includes(a.auth_state)).length;
  const suspectCount = all.filter(a => a.suspect_reason).length;
  const totals = list.reduce((t, a) => ({ life: t.life + a.earnings_total, bal: t.bal + a.balance, wd: t.wd + a.withdrawn }), { life: 0, bal: 0, wd: 0 });

  return (
    <>
      <PageHeader title="Tài khoản">
        <a href="/api/export/accounts"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
        <Button icon={Plus} onClick={() => setAdding(true)}>Thêm tài khoản</Button>
      </PageHeader>

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
          {groups.length > 0 && (
            <select value={group} onChange={e => setGroup(e.target.value)} className="h-9 rounded-xl border-0 bg-white px-3 text-sm ring-1 ring-inset ring-zinc-300/80 dark:bg-zinc-800/60 dark:ring-zinc-700 cursor-pointer">
              <option value="">Tất cả máy</option>
              {groups.map(g => <option key={g}>{g}</option>)}
            </select>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Tìm tên, email, ghi chú…" className="w-full lg:w-72" />
        </div>
      </div>

      <Card className="overflow-hidden">
        {list.length === 0 ? (
          <Empty icon={Users} title={all.length || filter === 'archived' ? 'Không có tài khoản phù hợp' : 'Chưa có tài khoản'}>
            {all.length || filter === 'archived' ? null : <Button className="mt-3" icon={Plus} onClick={() => setAdding(true)}>Thêm tài khoản đầu tiên</Button>}
          </Empty>
        ) : (
          <>
            {/* Bảng (desktop) */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800">
                    <th className="px-5 py-3 font-medium">Tài khoản</th>
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
                  {list.map(a => (
                    <tr key={a.id} onClick={() => navigate(`/accounts/${a.id}`)} className="cursor-pointer hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                      <td className="max-w-72 px-5 py-3.5">
                        <AccName label={a.label} email={a.email} group={a.group_name} sub={a.note} extra={<AuthIcon a={a} />} />
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
                  ))}
                </tbody>
                <tfoot>
                  <tr className="text-sm font-semibold">
                    <td className="px-5 py-3" colSpan={4}>Tổng {list.length} acc</td>
                    <td className="px-3 py-3 text-right tabular">{fmtBytes(list.reduce((s, a) => s + a.usage_today, 0))}</td>
                    <td className="px-3 py-3 text-right tabular">{usd(totals.bal)}</td>
                    <td className="px-3 py-3 text-right tabular">{usd(totals.wd)}</td>
                    <td className="px-3 py-3 text-right tabular">{usd(totals.life)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Thẻ (mobile) */}
            <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
              {list.map(a => (
                <li key={a.id}>
                  <Link to={`/accounts/${a.id}`} className="block px-4 py-3.5 active:bg-zinc-50 dark:active:bg-zinc-800/40">
                    <div className="flex items-center justify-between gap-3">
                      <AccName label={a.label} email={a.email} group={a.group_name} extra={<AuthIcon a={a} />} />
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
              ))}
            </ul>
          </>
        )}
      </Card>

      <AddAccountModal open={adding} onClose={() => setAdding(false)} onAdded={reload} />
    </>
  );
}
