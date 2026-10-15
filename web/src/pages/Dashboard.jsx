import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, Bell, Users, ChevronRight, ShieldAlert, Hourglass, KeyRound, AlertTriangle } from 'lucide-react';
import { api, usd, vnd, timeAgo, fmtBytes, fmtDateTime, DEVICE_STATUS } from '../lib';
import { AccountState } from './Accounts';
import { Card, CardHeader, Button, PageHeader, PageLoading, StatusDot, Empty, AccName, nameKey, byAccount, useData, useToast, cx } from '../ui';
import { DailyBars, UsageBars, StackedDaily, SeriesLegend } from '../charts';
import { useScope, ScopeFilter, SortTable, Delta, Uptime, SegTabs } from '../components';

const KPI = [
  { key: 'lifetime', label: 'Tổng đã kiếm' },
  { key: 'current', label: 'Số dư hiện tại' },
  { key: 'withdrawn', label: 'Đã rút về' },
  { key: 'banned', label: 'Mất do bị khoá' },
];

/** Dải số liệu: các ô cùng một khung, ngăn bằng đường kẻ mảnh */
export function StatStrip({ items, className }) {
  const three = items.length === 3;
  const border = i => three
    ? i > 0 && 'border-t sm:border-t-0 sm:border-l'
    : cx(i % 2 === 1 && 'border-l', i >= 2 && 'border-t xl:border-t-0', i === 2 && 'xl:border-l');
  return (
    <Card className={cx('grid overflow-hidden', three ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2 xl:grid-cols-4', className)}>
      {items.map((it, i) => (
        <div key={i} className={cx('min-w-0 border-zinc-200 px-4 py-4 sm:px-5 sm:py-5 dark:border-zinc-800', border(i))} title={it.title}>
          <div className="text-[12px] text-zinc-500 dark:text-zinc-400">{it.label}</div>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className={cx('font-semibold leading-none tabular', it.big ? 'text-[22px] sm:text-[26px]' : 'text-lg sm:text-xl')}>{it.value}</span>
            {it.right}
          </div>
          {it.sub && <div className="mt-1.5 truncate text-xs text-zinc-500 tabular">{it.sub}</div>}
        </div>
      ))}
    </Card>
  );
}

export function DeviceBar({ devices }) {
  const order = ['online', 'idle', 'offline', 'banned', ...(devices.unknown ? ['unknown'] : [])];
  const total = order.reduce((s, k) => s + (devices[k] || 0), 0);
  return (
    <div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        {total > 0 && order.map(k => devices[k] > 0 && (
          <div key={k} className={cx(DEVICE_STATUS[k].color, 'h-full first:rounded-l-full last:rounded-r-full')} style={{ width: `${(devices[k] / total) * 100}%` }} title={`${DEVICE_STATUS[k].label}: ${devices[k]}`} />
        ))}
      </div>
      <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {order.map(k => (
          <li key={k}>
            <Link to={`/devices?status=${k}`} className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
              <StatusDot status={k} size="sm" />
              <span className="flex-1 text-zinc-600 dark:text-zinc-300">{DEVICE_STATUS[k].label}</span>
              <span className="font-medium tabular">{devices[k] || 0}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LEVEL_DOT = { good: 'bg-good', warning: 'bg-warn', critical: 'bg-bad', info: 'bg-indigo-400' };

export function EventList({ events, showAccount = true }) {
  if (!events?.length) return <Empty icon={Bell} title="Chưa có hoạt động" />;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {events.map(e => (
        <li key={e.id} className="flex items-baseline gap-3 px-5 py-2.5">
          <span className={cx('size-1.5 shrink-0 -translate-y-0.5 rounded-full', LEVEL_DOT[e.level] || LEVEL_DOT.info)} />
          <p className="min-w-0 flex-1 text-sm">{e.message}{showAccount && e.account && e.account_id ? <> · <Link to={`/accounts/${e.account_id}`} className="text-zinc-500 hover:underline">{e.account}</Link></> : null}</p>
          <span className="shrink-0 text-xs text-zinc-400 tabular">{timeAgo(e.ts)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- Cần xử lý ----------
const ATTN = {
  suspect: { title: 'Nghi bị khoá', level: 'bg-bad' },
  device_banned: { title: 'Node mới bị ban', level: 'bg-bad' },
  auth: { title: 'Cookie hết hạn', level: 'bg-warn' },
  error: { title: 'Lỗi lấy dữ liệu', level: 'bg-warn' },
  device_offline: { title: 'Node rớt mạng', level: 'bg-muted' },
  device_idle: { title: 'Node lâu không tăng tiền', level: 'bg-warn' },
  limited: { title: 'Bị EarnApp giới hạn', level: 'bg-muted' },
};

function Attention({ items }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 6);
  return (
    <Card className="overflow-hidden">
      <CardHeader title={`Cần xử lý · ${items.length}`} />
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
        {shown.map((it, i) => {
          const m = ATTN[it.type] || ATTN.error;
          return (
            <li key={i}>
              <Link to={`/accounts/${it.account_id}`} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <span className={cx('size-1.5 shrink-0 rounded-full', m.level)} />
                <span className="w-36 shrink-0 font-medium sm:w-44">{m.title}{it.devices ? ` (${it.devices.length})` : ''}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-500">
                  {it.account}
                  <span className="hidden sm:inline"> · {it.devices ? it.devices.slice(0, 4).join(', ') + (it.devices.length > 4 ? ` +${it.devices.length - 4}` : '') : it.detail}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-zinc-300" />
              </Link>
            </li>
          );
        })}
      </ul>
      {items.length > 6 && (
        <button onClick={() => setAll(!all)} className="w-full border-t border-zinc-100 py-2 text-[13px] font-medium text-indigo-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-indigo-300 dark:hover:bg-zinc-800/40 cursor-pointer">
          {all ? 'Thu gọn' : `Xem thêm ${items.length - 6}`}
        </button>
      )}
    </Card>
  );
}

function DeviceDots({ r }) {
  const items = [['online', r.dev_online], ['idle', r.dev_idle], ['offline', r.dev_offline], ['banned', r.dev_banned], ['unknown', r.dev_unknown]].filter(([, n]) => n > 0);
  if (!items.length) return <span className="text-xs text-zinc-400">Chưa có node</span>;
  return <div className="flex items-center gap-2.5">{items.map(([k, n]) => <span key={k} className="inline-flex items-center gap-1 tabular"><StatusDot status={k} size="sm" />{n}</span>)}</div>;
}

function AccountFlags({ r }) {
  return (
    <>
      {r.suspect && <span title="Nghi bị khoá"><ShieldAlert className="size-3.5 text-red-500" /></span>}
      {r.auth_state === 'expired' && <span title="Cookie hết hạn"><KeyRound className="size-3.5 text-amber-500" /></span>}
      {r.limited && <span title="Đang bị giới hạn"><Hourglass className="size-3.5 text-zinc-400" /></span>}
    </>
  );
}

export default function Dashboard() {
  const toast = useToast();
  const navigate = useNavigate();
  const scope = useScope();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState('earn');
  const [split, setSplit] = useState('total');
  const [tableMode, setTableMode] = useState('accounts');
  const { data: d, loading, reload } = useData(() => api(`/overview?days=${days}&${scope.qs}`), [days, scope.qs], 30000);
  const [syncing, setSyncing] = useState(false);

  if (loading && !d) return <PageLoading />;
  if (!d) return null;

  const syncAll = async () => {
    setSyncing(true);
    try {
      const r = await api('/sync', { method: 'POST', body: {} });
      toast(`Đã xếp hàng ${r.queued} tài khoản, web sẽ lấy lần lượt từng acc`);
      setTimeout(reload, 5000);
    } catch (e) { toast(e.message, 'error'); } finally { setSyncing(false); }
  };

  const rate = d.usd_vnd;
  const totals = d.rows.reduce((t, r) => {
    for (const k of ['today', 'd7', 'usage_today', 'balance', 'withdrawn', 'lifetime', 'dev_total']) t[k] = (t[k] || 0) + (r[k] || 0);
    return t;
  }, {});

  const accountCols = [
    { key: 'name', label: 'Tài khoản', sort: nameKey, render: r => <AccName className="max-w-72" label={r.label} email={r.email} group={r.group} extra={<AccountFlags r={r} />} /> },
    { key: 'status', label: 'Trạng thái', hide: 'sm', render: r => <AccountState a={r} /> },
    { key: 'dev_online', label: 'Node', sort: r => r.dev_online + r.dev_idle, render: r => <DeviceDots r={r} /> },
    { key: 'today', label: 'Hôm nay', align: 'right', render: r => usd(r.today, 3) },
    { key: 'd7', label: '7 ngày', align: 'right', hide: 'md', render: r => usd(r.d7, 2) },
    { key: 'usage_today', label: 'Dung lượng', align: 'right', hide: 'lg', render: r => fmtBytes(r.usage_today) },
    { key: 'uptime_today', label: 'Online', align: 'right', hide: 'lg', title: 'Tỷ lệ thời gian node online hôm nay', render: r => <Uptime value={r.uptime_today} /> },
    { key: 'balance', label: 'Số dư', align: 'right', render: r => <span className="font-medium">{usd(r.balance)}</span> },
    { key: 'withdrawn', label: 'Đã rút', align: 'right', hide: 'xl', render: r => <>{usd(r.withdrawn)}{r.pending > 0 && <div className="text-xs text-amber-600">+{usd(r.pending)} chờ</div>}</> },
    { key: 'lifetime', label: 'Tổng kiếm', align: 'right', hide: 'md', render: r => usd(r.lifetime) },
    { key: 'last_sync_at', label: 'Cập nhật', hide: 'xl', className: 'whitespace-nowrap text-xs text-zinc-500', render: r => timeAgo(r.last_sync_at) },
  ];
  const groupCols = [
    { key: 'group', label: 'Máy', render: r => <span className="font-medium">{r.group}</span> },
    { key: 'accounts', label: 'Số acc', align: 'right' },
    { key: 'dev_online', label: 'Node', sort: r => r.dev_online + r.dev_idle, render: r => <DeviceDots r={r} /> },
    { key: 'today', label: 'Hôm nay', align: 'right', render: r => usd(r.today, 3) },
    { key: 'd7', label: '7 ngày', align: 'right', render: r => usd(r.d7, 2) },
    { key: 'usage_today', label: 'Dung lượng', align: 'right', hide: 'md', render: r => fmtBytes(r.usage_today) },
    { key: 'balance', label: 'Số dư', align: 'right', render: r => usd(r.balance) },
    { key: 'lifetime', label: 'Tổng kiếm', align: 'right', hide: 'md', render: r => usd(r.lifetime) },
  ];

  const devTotal = d.devices.online + d.devices.idle + d.devices.offline + d.devices.banned + (d.devices.unknown || 0);

  return (
    <>
      <PageHeader title="Tổng quan" subtitle={d.scope.all ? null : `Đang lọc ${d.accounts.total} tài khoản`}>
        <ScopeFilter scope={scope} />
        <Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={syncAll}>Đồng bộ</Button>
      </PageHeader>

      {d.stale > 0 && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          <span><b className="font-semibold">{d.stale}/{d.accounts.total} acc</b> chưa cập nhật{d.stale_since ? ` từ ${fmtDateTime(d.stale_since)}` : ''}, số liệu có thể đã cũ.</span>
        </div>
      )}

      {d.accounts.total === 0 && d.scope.all && (
        <Card className="mb-6 flex items-center justify-between gap-3 p-5">
          <span className="text-zinc-600 dark:text-zinc-300">Chưa có tài khoản nào</span>
          <Link to="/accounts?add=1"><Button>Thêm tài khoản</Button></Link>
        </Card>
      )}

      <StatStrip items={KPI.map(k => ({
        label: k.label, big: true, value: usd(d[k.key]), title: `≈ ${vnd(d[k.key] * rate)}`,
        sub: k.key === 'withdrawn' && d.pending > 0 ? <Link to="/payouts" className="text-amber-700 hover:underline dark:text-amber-400">+{usd(d.pending)} đang chờ</Link> : `≈ ${vnd(d[k.key] * rate)}`,
      }))} />

      <StatStrip className="mt-3" items={[
        { label: 'Hôm nay', value: usd(d.today, 3), right: <Delta now={d.today} prev={d.yesterday} />, sub: `Hôm qua ${usd(d.yesterday, 3)}` },
        { label: 'Tháng này', value: usd(d.month), right: <Delta now={d.month} prev={d.prev_month_to_date} />, sub: d.forecast_month != null ? `Dự kiến ${usd(d.forecast_month)}` : `≈ ${vnd(d.month * rate)}` },
        { label: 'Dung lượng hôm nay', value: fmtBytes(d.usage_today), right: <Delta now={d.usage_today} prev={d.usage_yesterday} />, sub: `Tháng ${fmtBytes(d.usage_month)}` },
        { label: 'Tốc độ', value: d.rate_per_hour != null ? `${usd(d.rate_per_hour, 3)}/giờ` : '—', title: d.rate_per_hour == null ? 'Cần ít nhất 3 giờ số liệu' : undefined,
          sub: <>Online <Uptime value={d.uptime_today} />{d.avg_daily != null && <> · TB {usd(d.avg_daily, 2)}/ngày</>}</> },
      ]} />

      {d.attention.length > 0 && <div className="mt-6"><Attention items={d.attention} /></div>}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <SegTabs size="md" value={metric} onChange={setMetric} items={[['earn', 'Thu nhập'], ['usage', 'Dung lượng']]} />
            <div className="flex flex-wrap gap-2">
              {metric === 'earn' && d.daily.series.length > 1 && <SegTabs value={split} onChange={setSplit} items={[['total', 'Tổng'], ['account', 'Theo acc']]} />}
              <SegTabs value={String(days)} onChange={v => setDays(Number(v))} items={[['7', '7N'], ['30', '30N'], ['90', '90N']]} />
            </div>
          </div>
          {metric === 'earn' && split === 'account' && <div className="px-5 pt-3"><SeriesLegend series={d.daily.series} /></div>}
          <div className="px-3 pb-4 pt-3">
            {metric === 'usage' ? <UsageBars data={d.usage_daily} />
              : split === 'account' && d.daily.series.length > 1 ? <StackedDaily data={d.daily.data} series={d.daily.series} rate={rate} />
                : <DailyBars data={d.daily.data} rate={rate} />}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={`Node · ${devTotal}`} action={<Link to="/devices" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-300">Xem</Link>} />
            <div className="px-5 pb-3"><DeviceBar devices={d.devices} /></div>
          </Card>
          <Card>
            <CardHeader title={`Tài khoản · ${d.accounts.total}`} action={<Link to="/accounts" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-300">Xem</Link>} />
            <div className="grid grid-cols-3 border-t border-zinc-100 text-center dark:border-zinc-800">
              {[['running', 'Đang chạy', ''], ['stopped', 'Đã dừng', 'text-amber-700 dark:text-amber-400'], ['banned', 'Bị khoá', 'text-bad']].map(([k, l, c], i) => (
                <Link key={k} to={`/accounts?filter=${k}`} className={cx('py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50', i > 0 && 'border-l border-zinc-100 dark:border-zinc-800')}>
                  <div className={cx('text-lg font-semibold tabular', d.accounts[k] > 0 && c)}>{d.accounts[k]}</div>
                  <div className="text-xs text-zinc-500">{l}</div>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
          <h3 className="text-[13px] font-semibold uppercase tracking-[.06em] text-zinc-500 dark:text-zinc-400">{tableMode === 'accounts' ? 'Theo tài khoản' : 'Theo máy'}</h3>
          {d.groups.length > 0 && <SegTabs value={tableMode} onChange={setTableMode} items={[['accounts', 'Tài khoản'], ['groups', 'Máy']]} />}
        </div>
        {tableMode === 'accounts' || !d.groups.length ? (
          <SortTable columns={accountCols} rows={[...d.rows].sort(byAccount)} initialSort={{ key: 'today', dir: 'desc' }} onRowClick={r => navigate(`/accounts/${r.id}`)}
            empty={<Empty icon={Users} title="Không có tài khoản" />}
            footer={d.rows.length > 1 ? {
              name: `Tổng ${d.rows.length} acc`, dev_online: `${totals.dev_total} node`, today: usd(totals.today, 3), d7: usd(totals.d7, 2),
              usage_today: fmtBytes(totals.usage_today), uptime_today: <Uptime value={d.uptime_today} />, balance: usd(totals.balance), withdrawn: usd(totals.withdrawn), lifetime: usd(totals.lifetime),
            } : null} />
        ) : (
          <SortTable columns={groupCols} rows={d.groups} initialSort={{ key: 'today', dir: 'desc' }}
            onRowClick={r => r.group !== 'Chưa gán máy' && scope.set({ group: r.group })} />
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Hoạt động gần đây" />
        <div className="border-t border-zinc-100 dark:border-zinc-800"><EventList events={d.events} /></div>
      </Card>
    </>
  );
}
