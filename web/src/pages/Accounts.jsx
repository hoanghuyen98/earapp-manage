import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Users, Download, KeyRound, PauseCircle, ChevronRight, HelpCircle, CheckCircle2, XCircle, ShieldAlert, Hourglass } from 'lucide-react';
import { api, usd, timeAgo, fmtBytes, ACCOUNT_STATUS } from '../lib';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Modal, Field, Input, Textarea, Empty, AccountBadge, StatusDot, useData, useToast, cx } from '../ui';

function DeviceCounts({ a }) {
  const items = [['online', a.dev_online], ['idle', a.dev_idle], ['offline', a.dev_offline], ['banned', a.dev_banned]].filter(([, n]) => n > 0);
  if (!items.length) return <span className="text-xs text-zinc-400">Chưa có máy</span>;
  return (
    <div className="flex items-center gap-2.5">
      {items.map(([k, n]) => <span key={k} className="inline-flex items-center gap-1 text-[13px] tabular"><StatusDot status={k} size="sm" />{n}</span>)}
    </div>
  );
}

function AuthIcon({ a }) {
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

function AddAccountModal({ open, onClose, onAdded }) {
  const [form, setForm] = useState({ cookies: '', label: '', group_name: '', proxy: '', note: '' });
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const lines = form.cookies.split('\n').filter(l => l.trim()).length;

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
    <Modal open={open} onClose={close} wide title="Thêm tài khoản" subtitle="Dán cookie của tài khoản EarnApp. Thêm nhiều acc cùng lúc: mỗi dòng 1 cookie."
      footer={results
        ? <Button onClick={close}>Xong</Button>
        : <><Button variant="secondary" onClick={close}>Huỷ</Button><Button loading={loading} disabled={!lines} onClick={submit} icon={Plus}>Thêm {lines > 1 ? `${lines} tài khoản` : ''}</Button></>}>
      {results ? (
        <ul className="space-y-2">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-2.5 rounded-xl bg-zinc-50 px-3 py-2.5 text-sm dark:bg-zinc-800/60">
              {r.ok ? <CheckCircle2 className="size-5 shrink-0 text-emerald-500" /> : <XCircle className="size-5 shrink-0 text-red-500" />}
              <span>{r.ok ? <><b>{r.email}</b>{r.updated ? ': đã cập nhật cookie mới' : ': đã thêm, đang tải dữ liệu…'}</> : <>Lỗi: {r.error}</>}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-4">
          <CookieGuide />
          <Field label="Cookie" hint="Dán cả chuỗi cookie, hoặc chỉ giá trị oauth-refresh-token.">
            <Textarea rows={4} value={form.cookies} onChange={e => setForm({ ...form, cookies: e.target.value })} placeholder="oauth-refresh-token=1%2F%2F0...; auth=1; ..." className="font-mono text-xs" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {lines <= 1 && <Field label="Tên gợi nhớ"><Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="VD: Acc VPS 1" /></Field>}
            <Field label="Nhóm"><Input value={form.group_name} onChange={e => setForm({ ...form, group_name: e.target.value })} placeholder="VD: VPS Mỹ" /></Field>
          </div>
          <Field label="Proxy (không bắt buộc)" hint="Dùng proxy riêng để lấy dữ liệu acc này, tránh EarnApp liên kết các acc qua cùng IP. VD: http://user:pass@1.2.3.4:8080">
            <Input value={form.proxy} onChange={e => setForm({ ...form, proxy: e.target.value })} placeholder="http://..." />
          </Field>
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
      (filter === 'all' || (filter === 'auth' ? ['expired', 'error'].includes(a.auth_state) : filter === 'suspect' ? !!a.suspect_reason : a.status === filter)) &&
      (!group || a.group_name === group) &&
      (!s || [a.email, a.label, a.note, a.group_name].some(x => x?.toLowerCase().includes(s))));
  }, [data, q, filter, group]);

  if (loading && !data) return <PageLoading />;
  const all = data || [];
  const count = k => all.filter(a => a.status === k).length;
  const authCount = all.filter(a => ['expired', 'error'].includes(a.auth_state)).length;
  const suspectCount = all.filter(a => a.suspect_reason).length;
  const totals = list.reduce((t, a) => ({ life: t.life + a.earnings_total, bal: t.bal + a.balance, wd: t.wd + a.withdrawn }), { life: 0, bal: 0, wd: 0 });

  return (
    <>
      <PageHeader title="Tài khoản" subtitle={`${all.length} tài khoản EarnApp`}>
        <a href="/api/export/accounts"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
        <Button icon={Plus} onClick={() => setAdding(true)}>Thêm tài khoản</Button>
      </PageHeader>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={filter} onChange={v => { v === 'all' ? params.delete('filter') : params.set('filter', v); setParams(params, { replace: true }); }} items={[
          { value: 'all', label: 'Tất cả', count: all.length },
          { value: 'running', label: 'Running', count: count('running'), dot: 'bg-good' },
          { value: 'stopped', label: 'Stopped', count: count('stopped'), dot: 'bg-warn' },
          { value: 'banned', label: 'Banned', count: count('banned'), dot: 'bg-bad' },
          ...(suspectCount ? [{ value: 'suspect', label: 'Nghi bị khoá', count: suspectCount, dot: 'bg-bad' }] : []),
          ...(authCount ? [{ value: 'auth', label: 'Cần cookie', count: authCount, dot: 'bg-amber-500' }] : []),
        ]} />
        <div className="flex gap-2">
          {groups.length > 0 && (
            <select value={group} onChange={e => setGroup(e.target.value)} className="rounded-xl border-0 bg-white px-3 py-2 text-sm ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700 cursor-pointer">
              <option value="">Tất cả nhóm</option>
              {groups.map(g => <option key={g}>{g}</option>)}
            </select>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Tìm email, tên, ghi chú…" className="w-full lg:w-72" />
        </div>
      </div>

      <Card className="overflow-hidden">
        {list.length === 0 ? (
          <Empty icon={Users} title={all.length ? 'Không có tài khoản phù hợp' : 'Chưa có tài khoản'}>
            {all.length ? 'Thử đổi bộ lọc hoặc từ khoá.' : <Button className="mt-3" icon={Plus} onClick={() => setAdding(true)}>Thêm tài khoản đầu tiên</Button>}
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
                    <th className="px-3 py-3 font-medium">Máy</th>
                    <th className="px-3 py-3 text-right font-medium">Hôm nay</th>
                    <th className="px-3 py-3 text-right font-medium">Dung lượng</th>
                    <th className="px-3 py-3 text-right font-medium">Số dư</th>
                    <th className="px-3 py-3 text-right font-medium">Đã rút</th>
                    <th className="px-3 py-3 text-right font-medium">Lifetime</th>
                    <th className="px-3 py-3 font-medium">Cập nhật</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {list.map(a => (
                    <tr key={a.id} onClick={() => navigate(`/accounts/${a.id}`)} className="cursor-pointer hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                      <td className="max-w-72 px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{a.label || a.email}</span>
                          <AuthIcon a={a} />
                        </div>
                        <div className="truncate text-xs text-zinc-500">
                          {a.label ? a.email : ''}{a.group_name && <span className="ml-1 rounded bg-zinc-100 px-1.5 py-px dark:bg-zinc-800">{a.group_name}</span>}
                          {a.note && <span className="ml-1">· {a.note}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3.5"><AccountBadge status={a.status} /></td>
                      <td className="px-3 py-3.5"><DeviceCounts a={a} /></td>
                      <td className="px-3 py-3.5 text-right tabular">{usd(a.today, 3)}</td>
                      <td className="px-3 py-3.5 text-right text-zinc-600 tabular dark:text-zinc-300">{fmtBytes(a.usage_today)}</td>
                      <td className="px-3 py-3.5 text-right font-medium tabular">{usd(a.balance)}</td>
                      <td className="px-3 py-3.5 text-right tabular">{usd(a.withdrawn)}{a.pending > 0 && <div className="text-xs text-amber-600">+{usd(a.pending)} chờ</div>}</td>
                      <td className="px-3 py-3.5 text-right tabular">{usd(a.earnings_total)}</td>
                      <td className="px-3 py-3.5 text-xs text-zinc-500 whitespace-nowrap">{timeAgo(a.last_sync_at)}</td>
                      <td className="pr-4"><ChevronRight className="size-4 text-zinc-300" /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-zinc-200 bg-zinc-50/60 text-sm font-semibold dark:border-zinc-800 dark:bg-zinc-800/30">
                    <td className="px-5 py-3" colSpan={4}>Tổng {list.length} tài khoản</td>
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
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{a.label || a.email}</span>
                        <AuthIcon a={a} />
                      </div>
                      <AccountBadge status={a.status} />
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <DeviceCounts a={a} />
                      <span className="text-sm font-semibold tabular">{usd(a.balance)}</span>
                    </div>
                    <div className="mt-1 flex justify-between text-xs text-zinc-500">
                      <span>Hôm nay {usd(a.today, 3)} · {fmtBytes(a.usage_today)}</span>
                      <span>Lifetime {usd(a.earnings_total)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <AddAccountModal open={adding} onClose={() => setAdding(false)} onAdded={() => { reload(); setTimeout(reload, 6000); }} />
    </>
  );
}
