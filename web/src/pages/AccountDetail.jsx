import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Pencil, Trash2, KeyRound, Server, Receipt, Bell, AlertTriangle, PauseCircle, ShieldAlert, Hourglass, History, Gauge, Ban, Undo2, Archive, ArchiveRestore } from 'lucide-react';
import { api, usd, vnd, timeAgo, timeUntil, fmtDate, fmtDateTime, fmtBytes } from '../lib';
import { Card, CardHeader, Button, PageLoading, Modal, Field, Input, Textarea, Toggle, ConfirmButton, Empty, AccountBadge, useData, useToast, cx } from '../ui';
import { DailyBars, UsageBars } from '../charts';
import { DeviceTable, StatusLegend } from './Devices';
import { TxTable } from './Payouts';
import { EventList } from './Dashboard';
import { CookieGuide } from './Accounts';

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
    <Modal open={open} onClose={onClose} wide title="Sửa tài khoản" subtitle={acc.email}
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button><Button loading={loading} onClick={save}>Lưu</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tên gợi nhớ"><Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder={acc.email} /></Field>
          <Field label="Nhóm"><Input value={form.group_name} onChange={e => setForm({ ...form, group_name: e.target.value })} /></Field>
        </div>
        <Field label="Ghi chú"><Textarea rows={2} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="VD: chạy ở VPS số 2, mua ngày 10/10" /></Field>
        <Field label="Proxy" hint="Để trống nếu không dùng. Hỗ trợ http://, https:// và socks5://. Dán dạng host:port:user:pass cũng được."><Input value={form.proxy} onChange={e => setForm({ ...form, proxy: e.target.value })} placeholder="socks5://user:pass@host:port" /></Field>
        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <Field label="Cập nhật cookie mới" hint="Chỉ điền khi cookie cũ hết hạn hoặc bị lỗi.">
            <Textarea rows={3} value={form.cookie} onChange={e => setForm({ ...form, cookie: e.target.value })} className="font-mono text-xs" placeholder="Dán cookie mới…" />
          </Field>
          <div className="mt-3"><CookieGuide /></div>
        </div>
        {!acc.archived_at && <Toggle checked={form.paused} onChange={v => setForm({ ...form, paused: v })} label="Tạm ngừng theo dõi" hint="Web sẽ không lấy dữ liệu acc này nữa, nhưng số liệu cũ vẫn giữ nguyên." />}
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
      <CardHeader title="Dung lượng" icon={Gauge}
        subtitle={<>Hôm nay ({today.date.slice(8, 10)}/{today.date.slice(5, 7)}): <b className="text-zinc-700 dark:text-zinc-200">{fmtBytes(today.value)}</b> · {isMonth ? '6 tháng' : `${daily.length} ngày`}: {fmtBytes(total)}</>}
        action={
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-800">
            {[['7', '7 ngày'], ['30', '30 ngày'], ['month', 'Theo tháng']].map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} className={cx('whitespace-nowrap rounded-md px-2.5 py-1 font-medium cursor-pointer', view === k ? 'bg-white shadow-sm dark:bg-zinc-700' : 'text-zinc-500')}>{l}</button>
            ))}
          </div>
        } />
      <div className="grid gap-2 pb-4 lg:grid-cols-[280px_1fr]">
        <div className="max-h-64 overflow-y-auto px-5 lg:border-r lg:border-zinc-100 lg:dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-zinc-900">
              <tr className="text-left text-xs text-zinc-500"><th className="py-2 font-medium">{isMonth ? 'Tháng' : 'Ngày'}</th><th className="py-2 text-right font-medium">Dung lượng</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {[...rows].reverse().map(r => (
                <tr key={r.date || r.month}>
                  <td className="py-2 font-medium">{label(r)}</td>
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
      <CardHeader title="Lịch sử số dư" icon={History} subtitle="Lưu mỗi giờ 1 lần, và mỗi khi có thay đổi bất thường" action={
        <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-800">
          {[[1, '24 giờ'], [7, '7 ngày'], [30, '30 ngày']].map(([n, l]) => (
            <button key={n} onClick={() => setDays(n)} className={cx('whitespace-nowrap rounded-md px-2.5 py-1 font-medium cursor-pointer', days === n ? 'bg-white shadow-sm dark:bg-zinc-700' : 'text-zinc-500')}>{l}</button>
          ))}
        </div>
      } />
      {snapshots.length === 0 ? <Empty icon={History} title="Chưa có dữ liệu" /> : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-zinc-900">
              <tr className="border-y border-zinc-100 text-left text-xs text-zinc-500 dark:border-zinc-800">
                <th className="px-5 py-2.5 font-medium">Thời điểm</th>
                <th className="px-3 py-2.5 text-right font-medium">Số dư</th>
                <th className="px-3 py-2.5 text-right font-medium">Lifetime</th>
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
      toast(banned ? `Đã chuyển sang Banned, ${usd(a.balance)} được tính vào mục "Mất do bị khoá"` : 'Đã bỏ qua, lần đồng bộ tới sẽ nhận số liệu mới');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };
  const setBanned = async (banned) => {
    await api(`/accounts/${a.id}`, { method: 'PATCH', body: { banned } });
    toast(banned ? `Đã đánh dấu bị khoá, ${usd(a.balance)} được tính vào "Mất do bị khoá"` : 'Đã bỏ đánh dấu, trạng thái tự động trở lại');
    reload();
  };
  const setArchived = async (archived) => {
    try {
      await api(`/accounts/${a.id}`, { method: 'PATCH', body: { archived } });
      toast(archived ? 'Đã lưu trữ. Số liệu cũ vẫn được tính vào tổng' : 'Đã khôi phục, đang lấy dữ liệu mới');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };
  const del = async () => {
    await api('/accounts/' + a.id, { method: 'DELETE' });
    toast('Đã xoá tài khoản');
    navigate('/accounts');
  };

  const stats = [
    ['Lifetime', a.earnings_total], ['Số dư hiện tại', a.balance], ['Đã rút', a.withdrawn], ['Đang chờ rút', a.pending],
  ];
  const devOrder = { online: 0, idle: 1, offline: 2, banned: 3 };
  const devices = [...a.devices].sort((x, y) => devOrder[x.status] - devOrder[y.status] || x.title.localeCompare(y.title));

  return (
    <>
      <Link to="/accounts" className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="size-4" /> Tài khoản</Link>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{a.label || a.email}</h1>
            <AccountBadge status={a.status} />
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {a.label && <>{a.email} · </>}
            {a.group_name && <>Nhóm {a.group_name} · </>}
            Tham gia {fmtDate(a.joined_at)} · Cập nhật {timeAgo(a.last_sync_at)}{!a.paused && a.next_sync_at ? <> · lần tới {timeUntil(a.next_sync_at)}</> : null}
          </p>
          {a.note && <p className="mt-2 inline-block rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">📝 {a.note}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {!a.archived_at && <Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={sync}>Cập nhật</Button>}
          <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Sửa</Button>
          {a.status === 'banned' ? (
            <ConfirmButton variant="secondary" icon={Undo2} title="Bỏ đánh dấu bị khoá?" confirmLabel="Bỏ đánh dấu"
              message={`Acc ${a.email} sẽ quay về trạng thái tự động (Running/Stopped theo máy). Số dư sẽ được cập nhật lại từ EarnApp ở lần lấy dữ liệu tới.`}
              onConfirm={() => setBanned(false)}>Bỏ đánh dấu khoá</ConfirmButton>
          ) : (
            <ConfirmButton variant="secondary" icon={Ban} title="Đánh dấu tài khoản bị khoá?" confirmLabel="Đánh dấu bị khoá"
              message={`Chỉ làm khi anh chắc chắn ${a.email} đã bị EarnApp khoá. Số dư hiện tại ${usd(a.balance)} sẽ được giữ lại và tính vào mục "Mất do bị khoá". Đánh dấu nhầm thì bấm "Bỏ đánh dấu khoá" để hoàn tác.`}
              onConfirm={() => setBanned(true)}>Đánh dấu bị khoá</ConfirmButton>
          )}
          {a.archived_at ? (
            <Button variant="secondary" icon={ArchiveRestore} onClick={() => setArchived(false)}>Khôi phục</Button>
          ) : (
            <ConfirmButton variant="secondary" icon={Archive} title="Lưu trữ tài khoản?" confirmLabel="Lưu trữ"
              message={`Web ngừng theo dõi ${a.email} và ẩn khỏi danh sách (xem lại ở tab "Lưu trữ"). Lịch sử rút, thu nhập, Lifetime vẫn được giữ và tính vào tổng. Dùng khi bỏ acc hoặc acc đã bị khoá.`}
              onConfirm={() => setArchived(true)}>Lưu trữ</ConfirmButton>
          )}
          <ConfirmButton variant="secondary" size="icon" icon={Trash2} title="Xoá hẳn tài khoản?" confirmLabel="Xoá hẳn"
            message={`Xoá ${a.email} khỏi web? Toàn bộ dữ liệu đã lưu (máy, lịch sử rút, thu nhập) của acc này bị xoá vĩnh viễn, các con số tổng (Lifetime, Đã rút, Mất do bị khoá, báo cáo lãi lỗ) sẽ giảm theo. Nếu chỉ muốn ngừng theo dõi thì nên bấm "Lưu trữ". Tài khoản EarnApp thật không bị ảnh hưởng.`} onConfirm={del} />
        </div>
      </div>

      {a.suspect_reason && (
        <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 sm:flex-row sm:items-center dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          <ShieldAlert className="size-5 shrink-0" />
          <div className="flex-1">
            <b>Có dấu hiệu bị khoá</b> ({timeAgo(a.suspect_at)}): {a.suspect_reason}.
            <div className="mt-0.5 text-red-800/80 dark:text-red-300/80">Web đang giữ số dư cũ {usd(a.balance)}. Vào EarnApp kiểm tra rồi chọn:</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="danger" onClick={() => resolveSuspect(true)}>Đúng, bị khoá</Button>
            <Button size="sm" variant="secondary" onClick={() => resolveSuspect(false)}>Không phải</Button>
          </div>
        </div>
      )}
      {a.backoff_until > Date.now() && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-zinc-200 bg-zinc-100 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-800/60">
          <Hourglass className="mt-0.5 size-5 shrink-0 text-zinc-500" />
          <div><b>EarnApp đang giới hạn truy cập.</b> Web tạm ngừng lấy dữ liệu acc này đến {fmtDateTime(a.backoff_until)} rồi tự thử lại.</div>
        </div>
      )}
      {!a.archived_at && a.auth_state === 'expired' && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <KeyRound className="mt-0.5 size-5 shrink-0" />
          <div className="flex-1"><b>Cookie đã hết hạn.</b> Có thể acc đã bị đăng xuất. Số liệu bên dưới là lần cập nhật cuối.</div>
          <Button size="sm" onClick={() => setEditing(true)}>Cập nhật cookie</Button>
        </div>
      )}
      {!a.archived_at && a.auth_state === 'error' && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <div><b>Lỗi khi lấy dữ liệu{a.error_streak > 1 ? ` (${a.error_streak} lần liên tiếp)` : ''}:</b> {a.last_error}</div>
        </div>
      )}
      {a.archived_at ? (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-100 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-800/60">
          <Archive className="size-5 shrink-0 text-zinc-500" />
          <div className="flex-1">Đã lưu trữ từ {fmtDateTime(a.archived_at)}. Web không theo dõi acc này nữa, số liệu bên dưới là lần cập nhật cuối.</div>
        </div>
      ) : !!a.paused && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-100 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-800/60">
          <PauseCircle className="size-5 text-zinc-500" /> Đang tạm ngừng theo dõi tài khoản này.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map(([l, v]) => (
          <Card key={l} className="p-4 sm:p-5">
            <div className="text-[13px] text-zinc-500">{l}</div>
            <div className="mt-1.5 text-xl font-semibold tabular sm:text-2xl">{usd(v)}</div>
            <div className="text-xs text-zinc-500 tabular">≈ {vnd(v * rate)}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardHeader title="Thu nhập 30 ngày" subtitle={`Hôm nay ${usd(a.today, 3)}`} />
        <div className="px-3 pb-4"><DailyBars data={a.daily} rate={rate} height={200} /></div>
      </Card>

      <UsageCard daily={a.usage_daily} monthly={a.usage_monthly} view={usageView} setView={setUsageView} />

      <Card className="mt-4 overflow-hidden">
        <CardHeader title="Máy (Node)" icon={Server} subtitle={`${a.dev_online} đang chạy · ${a.dev_idle} không ra tiền · ${a.dev_offline} rớt · ${a.dev_banned} bị ban`} />
        <DeviceTable devices={devices} />
        <div className="border-t border-zinc-100 px-5 py-3 dark:border-zinc-800"><StatusLegend /></div>
      </Card>

      <SnapshotCard snapshots={a.snapshots} days={snapDays} setDays={setSnapDays} />

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="overflow-hidden lg:col-span-3">
          <CardHeader title="Lịch sử rút tiền" icon={Receipt} />
          <TxTable list={a.transactions} />
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Hoạt động" icon={Bell} />
          <EventList events={a.events} showAccount={false} />
        </Card>
      </div>

      {editing && <EditModal acc={a} open onClose={() => setEditing(false)} onSaved={reload} />}
    </>
  );
}
