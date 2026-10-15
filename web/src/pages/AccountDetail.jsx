import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Pencil, Trash2, KeyRound, AlertTriangle, PauseCircle, ShieldAlert, Hourglass, History, Ban, Undo2, Archive, ArchiveRestore, MoreHorizontal } from 'lucide-react';
import { api, usd, vnd, timeAgo, fmtDateTime, fmtBytes, explainError } from '../lib';
import { Card, CardHeader, Button, PageLoading, Modal, Field, Input, Textarea, Toggle, Empty, useData, useToast, cx } from '../ui';
import { SegTabs } from '../components';
import { DailyBars, UsageBars } from '../charts';
import { DeviceTable } from './Devices';
import { TxTable } from './Payouts';
import { EventList, StatStrip } from './Dashboard';
import { CookieGuide, AccountState, ProxyField } from './Accounts';

function EditModal({ acc, open, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ label: acc.label || '', group_name: acc.group_name || '', note: acc.note || '', proxy: acc.proxy || '', paused: !!acc.paused, cookie: '' });
  const [loading, setLoading] = useState(false);
  const save = async () => {
    setLoading(true);
    try {
      const body = { ...form };
      if (!body.cookie) delete body.cookie;
      await api(`/accounts/${acc.id}`, { method: 'PATCH', body });
      toast(form.cookie ? 'Đã lưu, cookie mới hoạt động tốt' : 'Đã lưu');
      onSaved(); onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setLoading(false); }
  };
  return (
    <Modal open={open} onClose={onClose} wide title="Sửa tài khoản" subtitle={acc.label ? `${acc.label} · ${acc.email}` : acc.email}
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button><Button loading={loading} onClick={save}>Lưu</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tên riêng"><Input value={form.label} maxLength={40} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="VD: A1" /></Field>
          <Field label="Máy"><Input value={form.group_name} onChange={e => setForm({ ...form, group_name: e.target.value })} placeholder="VD: VPS-01" /></Field>
        </div>
        <Field label="Ghi chú"><Textarea rows={2} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>
        <ProxyField value={form.proxy} onChange={v => setForm({ ...form, proxy: v })} />
        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <Field label="Cookie mới" hint="Chỉ điền khi cookie cũ hết hạn.">
            <Textarea rows={3} value={form.cookie} onChange={e => setForm({ ...form, cookie: e.target.value })} className="font-mono text-xs" placeholder="Dán cookie mới…" />
          </Field>
          <div className="mt-3"><CookieGuide /></div>
        </div>
        {!acc.archived_at && <Toggle checked={form.paused} onChange={v => setForm({ ...form, paused: v })} label="Tạm ngừng theo dõi" hint="Giữ số liệu cũ, không lấy dữ liệu mới." />}
      </div>
    </Modal>
  );
}

function UsageCard({ daily, monthly, view, setView }) {
  const isMonth = view === 'month';
  const rows = isMonth ? monthly : daily;
  const total = rows.reduce((s, r) => s + r.value, 0);
  const today = daily[daily.length - 1];
  const label = r => isMonth ? `Tháng ${Number(r.month.slice(5))}/${r.month.slice(0, 4)}` : `${r.date.slice(8, 10)}-${r.date.slice(5, 7)}`;
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader title="Dung lượng"
        subtitle={<>Hôm nay {fmtBytes(today.value)} · {isMonth ? '6 tháng' : `${daily.length} ngày`} {fmtBytes(total)}</>}
        action={<SegTabs value={view} onChange={setView} items={[['7', '7N'], ['30', '30N'], ['month', 'Tháng']]} />} />
      <div className="grid gap-2 pb-4 lg:grid-cols-[280px_1fr]">
        <div className="max-h-64 overflow-y-auto px-5 lg:border-r lg:border-zinc-100 lg:dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-zinc-900">
              <tr className="text-left text-zinc-500"><th className="py-2 font-medium">{isMonth ? 'Tháng' : 'Ngày'}</th><th className="py-2 text-right font-medium">Dung lượng</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {[...rows].reverse().map(r => (
                <tr key={r.date || r.month}>
                  <td className="py-2">{label(r)}</td>
                  <td className="py-2 text-right tabular">{fmtBytes(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3">
          <UsageBars data={rows} xKey={isMonth ? 'month' : 'date'} height={240} />
        </div>
      </div>
    </Card>
  );
}

function SnapshotCard({ snapshots, days, setDays }) {
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader title="Lịch sử số dư" action={<SegTabs value={String(days)} onChange={v => setDays(Number(v))} items={[['1', '24G'], ['7', '7N'], ['30', '30N']]} />} />
      {snapshots.length === 0 ? <Empty icon={History} title="Chưa có dữ liệu" /> : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-zinc-900">
              <tr className="text-left text-zinc-500">
                <th className="px-5 py-2.5 font-medium">Thời điểm</th>
                <th className="px-3 py-2.5 text-right font-medium">Số dư</th>
                <th className="px-3 py-2.5 text-right font-medium">Tổng kiếm</th>
                <th className="px-5 py-2.5 text-right font-medium">Kiếm thêm</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {snapshots.map((r, i) => {
                const prev = snapshots[i + 1];
                const diff = prev ? r.earnings_total - prev.earnings_total : null;
                return (
                  <tr key={r.ts}>
                    <td className="px-5 py-2 whitespace-nowrap text-zinc-600 dark:text-zinc-300">{fmtDateTime(r.ts)}</td>
                    <td className="px-3 py-2 text-right font-medium tabular">{usd(r.balance, 3)}</td>
                    <td className="px-3 py-2 text-right tabular">{usd(r.earnings_total, 3)}</td>
                    <td className={cx('px-5 py-2 text-right tabular', diff < 0 ? 'font-semibold text-red-600 dark:text-red-400' : 'text-zinc-500')}>
                      {diff == null ? '—' : (diff >= 0 ? '+' : '−') + usd(Math.abs(diff), 3)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Menu thao tác ít dùng */
function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const h = e => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="icon" icon={MoreHorizontal} title="Thêm" onClick={() => setOpen(!open)} />
      {open && (
        <div className="absolute right-0 z-40 mt-1.5 w-52 rounded-xl border border-zinc-200 bg-white py-1 shadow-lg animate-fade-in dark:border-zinc-700 dark:bg-zinc-900">
          {items.map(it => (
            <button key={it.label} onClick={() => { setOpen(false); it.onClick(); }}
              className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer', it.danger && 'text-bad')}>
              <it.icon className="size-4 opacity-70" />{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Thanh thông báo 1 dòng */
function Notice({ tone = 'neutral', icon: Icon, children, action }) {
  const tones = {
    neutral: 'border-zinc-200 bg-zinc-100/70 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300',
    warn: 'border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200',
    bad: 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200',
  };
  return (
    <div className={cx('mb-3 flex flex-col gap-2.5 rounded-xl border px-4 py-2.5 text-sm sm:flex-row sm:items-center', tones[tone])}>
      <div className="flex flex-1 items-start gap-2.5"><Icon className="mt-0.5 size-4 shrink-0" /><div className="min-w-0">{children}</div></div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

export default function AccountDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [snapDays, setSnapDays] = useState(1);
  const [usageView, setUsageView] = useState('7');
  const usageDays = usageView === '30' ? 30 : 7;
  const { data: a, loading, error, reload } = useData(() => api(`/accounts/${id}?snap_days=${snapDays}&usage_days=${usageDays}`), [id, snapDays, usageDays], 30000);
  const [editing, setEditing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [confirming, setConfirming] = useState(false);

  if (loading && !a) return <PageLoading />;
  if (error && !a) return <Empty title="Không tìm thấy tài khoản"><Link to="/accounts" className="text-indigo-600">← Quay lại</Link></Empty>;

  const rate = a.usd_vnd;
  const sync = async () => {
    setSyncing(true);
    try { await api('/sync', { method: 'POST', body: { id: a.id } }); await reload(); toast('Đã cập nhật dữ liệu mới nhất'); }
    catch (e) { toast(e.message, 'error'); } finally { setSyncing(false); }
  };
  const resolveSuspect = async (banned) => {
    try {
      await api(`/accounts/${a.id}`, { method: 'PATCH', body: banned ? { banned: true } : { dismiss_suspect: true } });
      toast(banned ? 'Đã đánh dấu bị khoá' : 'Đã bỏ qua');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };
  const setBanned = async (banned) => {
    await api(`/accounts/${a.id}`, { method: 'PATCH', body: { banned } });
    toast(banned ? 'Đã đánh dấu bị khoá' : 'Đã bỏ đánh dấu khoá');
    reload();
  };
  const setArchived = async (archived) => {
    try {
      await api(`/accounts/${a.id}`, { method: 'PATCH', body: { archived } });
      toast(archived ? 'Đã lưu trữ' : 'Đã khôi phục');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };
  const del = async () => {
    await api('/accounts/' + a.id, { method: 'DELETE' });
    toast('Đã xoá tài khoản');
    navigate('/accounts');
  };

  const devOrder = { online: 0, idle: 1, offline: 2, banned: 3 };
  const devices = [...a.devices].sort((x, y) => devOrder[x.status] - devOrder[y.status] || x.title.localeCompare(y.title));
  const menu = [
    a.status === 'banned'
      ? { label: 'Bỏ đánh dấu khoá', icon: Undo2, onClick: () => setConfirm({ title: 'Bỏ đánh dấu bị khoá?', confirmLabel: 'Bỏ đánh dấu', message: 'Trạng thái acc sẽ tự động theo node như trước.', run: () => setBanned(false) }) }
      : { label: 'Đánh dấu bị khoá', icon: Ban, onClick: () => setConfirm({ title: 'Đánh dấu bị khoá?', confirmLabel: 'Đánh dấu', message: `Số dư ${usd(a.balance)} sẽ tính vào "Mất do bị khoá". Hoàn tác được.`, run: () => setBanned(true) }) },
    a.archived_at
      ? { label: 'Khôi phục', icon: ArchiveRestore, onClick: () => setArchived(false) }
      : { label: 'Lưu trữ', icon: Archive, onClick: () => setConfirm({ title: 'Lưu trữ tài khoản?', confirmLabel: 'Lưu trữ', message: 'Ngừng theo dõi và ẩn khỏi danh sách. Số liệu cũ vẫn tính vào tổng.', run: () => setArchived(true) }) },
    { label: 'Xoá hẳn', icon: Trash2, danger: true, onClick: () => setConfirm({ title: 'Xoá hẳn tài khoản?', confirmLabel: 'Xoá hẳn', danger: true, message: 'Xoá vĩnh viễn mọi số liệu của acc này trên web, các con số tổng sẽ giảm theo. Muốn giữ số liệu thì dùng "Lưu trữ".', run: del }) },
  ];

  return (
    <>
      <Link to="/accounts" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="size-3.5" /> Tài khoản</Link>

      <div className="mb-6 flex flex-col gap-4 border-b border-zinc-200 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-zinc-800">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-[22px] font-semibold leading-tight">{a.label || a.email}</h1>
            {a.label && <span className="truncate text-[15px] text-zinc-500">{a.email}</span>}
            <AccountState a={a} />
          </div>
          <p className="mt-1 text-[13px] text-zinc-500">
            {a.group_name && <>{a.group_name} · </>}{a.proxy_info ? <>Proxy {a.proxy_info} · </> : null}Cập nhật {timeAgo(a.last_ok_at || a.last_sync_at)}
            {a.note && <> · <span className="text-zinc-700 dark:text-zinc-300">{a.note}</span></>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {!a.archived_at && <Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={sync}>Cập nhật</Button>}
          <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Sửa</Button>
          <MoreMenu items={menu} />
        </div>
      </div>

      {a.suspect_reason && (
        <Notice tone="bad" icon={ShieldAlert} action={<>
          <Button size="sm" variant="danger" onClick={() => resolveSuspect(true)}>Đúng, bị khoá</Button>
          <Button size="sm" variant="secondary" onClick={() => resolveSuspect(false)}>Không phải</Button>
        </>}>
          <b className="font-semibold">Nghi bị khoá</b> · {a.suspect_reason}
        </Notice>
      )}
      {a.backoff_until > Date.now() && (
        <Notice icon={Hourglass}><b className="font-semibold">EarnApp đang giới hạn.</b> Tự thử lại lúc {fmtDateTime(a.backoff_until)}.</Notice>
      )}
      {!a.archived_at && a.auth_state === 'expired' && (
        <Notice tone="warn" icon={KeyRound} action={<Button size="sm" onClick={() => setEditing(true)}>Cập nhật cookie</Button>}>
          <b className="font-semibold">Cookie hết hạn.</b> Số liệu là của lần cập nhật cuối.
        </Notice>
      )}
      {!a.archived_at && a.auth_state === 'error' && (
        <Notice tone="bad" icon={AlertTriangle}>
          <b className="font-semibold">{a.stale ? `Chưa lấy được dữ liệu từ ${fmtDateTime(a.last_ok_at)}` : 'Lỗi lấy dữ liệu'}{a.error_streak > 1 ? ` (${a.error_streak} lần)` : ''}.</b> {explainError(a.last_error)}
        </Notice>
      )}
      {a.archived_at ? (
        <Notice icon={Archive}>Đã lưu trữ từ {fmtDateTime(a.archived_at)}.</Notice>
      ) : !!a.paused && (
        <Notice icon={PauseCircle}>Đang tạm ngừng theo dõi.</Notice>
      )}

      <StatStrip className={a.suspect_reason || a.auth_state !== 'ok' || a.archived_at || a.paused ? 'mt-4' : ''} items={[
        ['Tổng đã kiếm', a.earnings_total], ['Số dư hiện tại', a.balance], ['Đã rút', a.withdrawn], ['Đang chờ rút', a.pending],
      ].map(([label, v]) => ({ label, big: true, value: usd(v), sub: `≈ ${vnd(v * rate)}` }))} />

      <Card className="mt-4">
        <CardHeader title="Thu nhập 30 ngày" subtitle={`Hôm nay ${usd(a.today, 3)}`} />
        <div className="px-3 pb-4"><DailyBars data={a.daily} rate={rate} height={200} /></div>
      </Card>

      <UsageCard daily={a.usage_daily} monthly={a.usage_monthly} view={usageView} setView={setUsageView} />

      <Card className="mt-4 overflow-hidden">
        <CardHeader title={`Node · ${a.devices.length}`} subtitle={[[a.dev_online, 'đang chạy'], [a.dev_idle, 'lâu không tăng tiền'], [a.dev_offline, 'rớt'], [a.dev_banned, 'bị ban'], [a.dev_unknown, 'chưa rõ']].filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`).join(' · ') || 'Chưa có node'} />
        <DeviceTable devices={devices} />
      </Card>

      <SnapshotCard snapshots={a.snapshots} days={snapDays} setDays={setSnapDays} />

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="overflow-hidden lg:col-span-3">
          <CardHeader title="Lịch sử rút tiền" />
          <TxTable list={a.transactions} />
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Hoạt động" />
          <EventList events={a.events} showAccount={false} />
        </Card>
      </div>

      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title={confirm.title}
          footer={<>
            <Button variant="secondary" onClick={() => setConfirm(null)}>Huỷ</Button>
            <Button variant={confirm.danger ? 'danger' : 'primary'} loading={confirming}
              onClick={async () => { setConfirming(true); try { await confirm.run(); setConfirm(null); } catch (e) { toast(e.message, 'error'); } finally { setConfirming(false); } }}>{confirm.confirmLabel}</Button>
          </>}>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{confirm.message}</p>
        </Modal>
      )}
      {editing && <EditModal acc={a} open onClose={() => setEditing(false)} onSaved={reload} />}
    </>
  );
}
