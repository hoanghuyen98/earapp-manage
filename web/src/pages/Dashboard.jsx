import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  TrendingUp, Wallet, ArrowDownToLine, Ban, RefreshCw, CalendarDays, Activity, Bell, Users, ChevronRight,
  ShieldAlert, Hourglass, Gauge, Zap, KeyRound, WifiOff, CircleSlash, CheckCircle2, AlertTriangle, Signal, Layers,
} from 'lucide-react';
import { api, usd, vnd, timeAgo, fmtBytes, DEVICE_STATUS } from '../lib';
import { Card, CardHeader, Button, PageHeader, PageLoading, StatusDot, Empty, AccountBadge, useData, useToast, cx } from '../ui';
import { DailyBars, UsageBars, StackedDaily, SeriesLegend } from '../charts';
import { useScope, ScopeFilter, SortTable, Delta, Uptime, SegTabs, pct } from '../components';

const KPI = [
  { key: 'lifetime', label: 'Tổng đã kiếm', sub: 'Lifetime', icon: TrendingUp, tone: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-500/10 dark:text-indigo-300' },
  { key: 'current', label: 'Số dư hiện tại', sub: 'Chưa rút', icon: Wallet, tone: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-300' },
  { key: 'withdrawn', label: 'Đã rút về', sub: 'Đã thanh toán', icon: ArrowDownToLine, tone: 'text-sky-600 bg-sky-50 dark:bg-sky-500/10 dark:text-sky-300' },
  { key: 'banned', label: 'Mất do bị khoá', sub: 'Số dư kẹt ở acc bị ban', icon: Ban, tone: 'text-red-600 bg-red-50 dark:bg-red-500/10 dark:text-red-300' },
];

export function KpiCard({ label, sub, value, rate, icon: Icon, tone, extra }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium leading-tight text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className={cx('rounded-lg p-1.5', tone)}><Icon className="size-4" /></span>
      </div>
      <div className="mt-3 text-[22px] font-semibold leading-none tracking-tight tabular sm:text-[28px]">{usd(value)}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="tabular">≈ {vnd(value * rate)}</span>
        {extra || <span className="hidden truncate sm:inline">{sub}</span>}
      </div>
    </Card>
  );
}

export function DeviceBar({ devices }) {
  const order = ['online', 'idle', 'offline', 'banned'];
  const total = order.reduce((s, k) => s + (devices[k] || 0), 0);
  return (
    <div>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        {total > 0 && order.map(k => devices[k] > 0 && (
          <div key={k} className={cx(DEVICE_STATUS[k].color, 'h-full first:rounded-l-full last:rounded-r-full')} style={{ width: `${(devices[k] / total) * 100}%` }} title={`${DEVICE_STATUS[k].label}: ${devices[k]}`} />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {order.map(k => (
          <Link key={k} to={`/devices?status=${k}`} className="group -m-2 flex items-center gap-2.5 rounded-xl p-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
            <StatusDot status={k} />
            <div className="min-w-0">
              <div className="text-lg font-semibold leading-tight tabular">{devices[k] || 0}</div>
              <div className="truncate text-xs text-zinc-500">{DEVICE_STATUS[k].label}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

const LEVEL_DOT = { good: 'bg-good', warning: 'bg-warn', critical: 'bg-bad', info: 'bg-indigo-400' };

export function EventList({ events, showAccount = true }) {
  if (!events?.length) return <Empty icon={Bell} title="Chưa có sự kiện">Các thay đổi như máy rớt mạng, acc bị khoá, lệnh rút mới sẽ hiện ở đây.</Empty>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {events.map(e => (
        <li key={e.id} className="flex gap-3 px-5 py-3">
          <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', LEVEL_DOT[e.level] || LEVEL_DOT.info)} />
          <div className="min-w-0 flex-1">
            <p className="text-sm">{e.message}</p>
            <p className="mt-0.5 text-xs text-zinc-500">{timeAgo(e.ts)}{showAccount && e.account && e.account_id ? <> · <Link to={`/accounts/${e.account_id}`} className="hover:underline">{e.account}</Link></> : null}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------- Cần xử lý ----------
const ATTN = {
  suspect: { icon: ShieldAlert, title: 'Nghi bị khoá', tone: 'text-red-600 bg-red-50 dark:bg-red-500/10 dark:text-red-400' },
  device_banned: { icon: CircleSlash, title: 'Máy mới bị ban (24h)', tone: 'text-red-600 bg-red-50 dark:bg-red-500/10 dark:text-red-400' },
  auth: { icon: KeyRound, title: 'Cookie hết hạn', tone: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-400' },
  error: { icon: AlertTriangle, title: 'Lỗi lấy dữ liệu', tone: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-400' },
  device_offline: { icon: WifiOff, title: 'Máy rớt mạng', tone: 'text-red-600 bg-red-50 dark:bg-red-500/10 dark:text-red-400' },
  device_idle: { icon: Zap, title: 'Máy không ra tiền', tone: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-400' },
  limited: { icon: Hourglass, title: 'Bị EarnApp giới hạn', tone: 'text-zinc-600 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300' },
};

function Attention({ items }) {
  const [all, setAll] = useState(false);
  if (!items.length) {
    return (
      <Card className="flex items-center gap-3 px-5 py-4">
        <CheckCircle2 className="size-5 text-emerald-500" />
        <span className="text-sm"><b>Mọi thứ ổn.</b> <span className="text-zinc-500">Không có máy rớt, acc lỗi hay cookie hết hạn.</span></span>
      </Card>
    );
  }
  const shown = all ? items : items.slice(0, 6);
  return (
    <Card>
      <CardHeader title={`Cần xử lý (${items.length})`} icon={AlertTriangle} subtitle="Xếp theo mức độ nghiêm trọng" />
      <ul className="grid gap-2 px-5 pb-5 md:grid-cols-2">
        {shown.map((it, i) => {
          const m = ATTN[it.type] || ATTN.error;
          return (
            <li key={i}>
              <Link to={`/accounts/${it.account_id}`} className="flex h-full items-start gap-3 rounded-xl border border-zinc-100 p-3 hover:border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
                <span className={cx('rounded-lg p-1.5', m.tone)}><m.icon className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{m.title}{it.devices ? ` · ${it.devices.length} máy` : ''}</div>
                  <div className="truncate text-xs text-zinc-500">{it.account}</div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {it.devices ? it.devices.slice(0, 4).join(', ') + (it.devices.length > 4 ? `, +${it.devices.length - 4}` : '') : it.detail}
                  </div>
                </div>
                <ChevronRight className="mt-1 size-4 shrink-0 text-zinc-300" />
              </Link>
            </li>
          );
        })}
      </ul>
      {items.length > 6 && (
        <button onClick={() => setAll(!all)} className="w-full border-t border-zinc-100 py-2.5 text-sm font-medium text-indigo-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-indigo-400 dark:hover:bg-zinc-800/40 cursor-pointer">
          {all ? 'Thu gọn' : `Xem tất cả ${items.length} mục`}
        </button>
      )}
    </Card>
  );
}

// ---------- Ô số nhỏ ----------
function Stat({ icon: Icon, label, value, sub, right }) {
  return (
    <Card className="flex items-start gap-4 p-5">
      <div className="rounded-xl bg-zinc-100 p-2.5 dark:bg-zinc-800"><Icon className="size-5 text-zinc-500" /></div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-zinc-500">{label}</div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold tabular">{value}</span>
          {right}
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">{sub}</div>
      </div>
    </Card>
  );
}

function DeviceDots({ r }) {
  const items = [['online', r.dev_online], ['idle', r.dev_idle], ['offline', r.dev_offline], ['banned', r.dev_banned]].filter(([, n]) => n > 0);
  if (!items.length) return <span className="text-xs text-zinc-400">Chưa có máy</span>;
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
    { key: 'name', label: 'Tài khoản', sort: r => r.name.toLowerCase(), render: r => (
      <div className="min-w-0 max-w-72">
        <div className="flex items-center gap-1.5"><span className="truncate font-medium">{r.name}</span><AccountFlags r={r} /></div>
        <div className="truncate text-xs text-zinc-500">{r.name !== r.email ? r.email : ''}{r.group && <span className="ml-1 rounded bg-zinc-100 px-1.5 py-px dark:bg-zinc-800">{r.group}</span>}</div>
      </div>
    ) },
    { key: 'status', label: 'Trạng thái', hide: 'sm', render: r => <AccountBadge status={r.status} /> },
    { key: 'dev_online', label: 'Máy', sort: r => r.dev_online + r.dev_idle, render: r => <DeviceDots r={r} /> },
    { key: 'today', label: 'Hôm nay', align: 'right', render: r => usd(r.today, 3) },
    { key: 'd7', label: '7 ngày', align: 'right', hide: 'md', render: r => usd(r.d7, 2) },
    { key: 'usage_today', label: 'Dung lượng', align: 'right', hide: 'lg', render: r => fmtBytes(r.usage_today) },
    { key: 'uptime_today', label: 'Uptime', align: 'right', hide: 'lg', title: 'Tỷ lệ thời gian máy online hôm nay', render: r => <Uptime value={r.uptime_today} /> },
    { key: 'balance', label: 'Số dư', align: 'right', render: r => <span className="font-medium">{usd(r.balance)}</span> },
    { key: 'withdrawn', label: 'Đã rút', align: 'right', hide: 'xl', render: r => <>{usd(r.withdrawn)}{r.pending > 0 && <div className="text-xs text-amber-600">+{usd(r.pending)} chờ</div>}</> },
    { key: 'lifetime', label: 'Lifetime', align: 'right', hide: 'md', render: r => usd(r.lifetime) },
    { key: 'last_sync_at', label: 'Cập nhật', hide: 'xl', className: 'whitespace-nowrap text-xs text-zinc-500', render: r => timeAgo(r.last_sync_at) },
  ];
  const groupCols = [
    { key: 'group', label: 'Nhóm', render: r => <span className="font-medium">{r.group}</span> },
    { key: 'accounts', label: 'Số acc', align: 'right' },
    { key: 'dev_online', label: 'Máy', sort: r => r.dev_online + r.dev_idle, render: r => <DeviceDots r={r} /> },
    { key: 'today', label: 'Hôm nay', align: 'right', render: r => usd(r.today, 3) },
    { key: 'd7', label: '7 ngày', align: 'right', render: r => usd(r.d7, 2) },
    { key: 'usage_today', label: 'Dung lượng', align: 'right', hide: 'md', render: r => fmtBytes(r.usage_today) },
    { key: 'balance', label: 'Số dư', align: 'right', render: r => usd(r.balance) },
    { key: 'lifetime', label: 'Lifetime', align: 'right', hide: 'md', render: r => usd(r.lifetime) },
  ];

  return (
    <>
      <PageHeader title="Tổng quan" subtitle={
        <span className="inline-flex items-center gap-1.5">
          {d.scope.all ? 'Tất cả tài khoản' : `Đang lọc ${d.accounts.total} tài khoản`} · <RefreshCw className="size-3.5" /> tự cập nhật mỗi 30 giây
        </span>
      }>
        <ScopeFilter scope={scope} />
        <Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={syncAll}>Đồng bộ ngay</Button>
      </PageHeader>

      {d.accounts.total === 0 && d.scope.all && (
        <Card className="mb-6 flex flex-col items-start gap-3 border-dashed p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Chưa có tài khoản nào</p>
            <p className="text-sm text-zinc-500">Thêm tài khoản EarnApp đầu tiên để bắt đầu theo dõi.</p>
          </div>
          <Link to="/accounts?add=1"><Button>Thêm tài khoản</Button></Link>
        </Card>
      )}

      {/* 4 mục tổng */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {KPI.map(k => (
          <KpiCard key={k.key} {...k} value={d[k.key]} rate={rate}
            extra={k.key === 'withdrawn' && d.pending > 0 ? <Link to="/payouts" className="truncate text-amber-600 hover:underline">+{usd(d.pending)} đang chờ</Link> : null} />
        ))}
      </div>

      {/* Hôm nay / tháng / dung lượng / tốc độ */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Activity} label="Hôm nay" value={usd(d.today, 3)} right={<Delta now={d.today} prev={d.yesterday} />}
          sub={<>Hôm qua {usd(d.yesterday, 3)}{d.forecast_today != null && <><br />Dự kiến cả ngày ≈ <b className="text-zinc-700 dark:text-zinc-300">{usd(d.forecast_today, 2)}</b></>}</>} />
        <Stat icon={CalendarDays} label="Tháng này" value={usd(d.month)} right={<Delta now={d.month} prev={d.prev_month_to_date} />}
          sub={<>≈ {vnd(d.month * rate)}{d.forecast_month != null && <><br />Dự kiến cả tháng ≈ <b className="text-zinc-700 dark:text-zinc-300">{usd(d.forecast_month)}</b></>}</>} />
        <Stat icon={Gauge} label="Dung lượng hôm nay" value={fmtBytes(d.usage_today)} right={<Delta now={d.usage_today} prev={d.usage_yesterday} />}
          sub={<>7 ngày {fmtBytes(d.usage_7d)} · tháng {fmtBytes(d.usage_month)}</>} />
        <Stat icon={Signal} label="Tốc độ kiếm tiền" value={d.rate_per_hour != null ? `${usd(d.rate_per_hour, 3)}/giờ` : <span className="text-base font-medium text-zinc-400">Đang thu thập…</span>}
          sub={<>{d.rate_per_hour == null && <>Cần ít nhất 3 giờ số liệu<br /></>}Uptime hôm nay <Uptime value={d.uptime_today} />{d.avg_daily != null && <> · TB {usd(d.avg_daily, 2)}/ngày</>}</>} />
      </div>

      {/* Cần xử lý */}
      <div className="mt-4"><Attention items={d.attention} /></div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Biểu đồ */}
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
            <SegTabs size="md" value={metric} onChange={setMetric} items={[['earn', 'Thu nhập'], ['usage', 'Dung lượng']]} />
            <div className="flex flex-wrap gap-2">
              {metric === 'earn' && d.daily.series.length > 1 && <SegTabs value={split} onChange={setSplit} items={[['total', 'Tổng'], ['account', 'Theo tài khoản']]} />}
              <SegTabs value={String(days)} onChange={v => setDays(Number(v))} items={[['7', '7 ngày'], ['30', '30 ngày'], ['90', '90 ngày']]} />
            </div>
          </div>
          <div className="px-5 pt-2 text-xs text-zinc-500">
            {metric === 'earn' ? `Thu nhập theo ngày (USD)${d.data_since ? ` · có số liệu từ ${d.data_since.split('-').reverse().join('/')}` : ''}` : 'Dung lượng theo ngày (theo ngày của EarnApp)'}
          </div>
          {metric === 'earn' && split === 'account' && <div className="px-5 pt-3"><SeriesLegend series={d.daily.series} /></div>}
          <div className="px-3 pb-4 pt-2">
            {metric === 'usage' ? <UsageBars data={d.usage_daily} />
              : split === 'account' && d.daily.series.length > 1 ? <StackedDaily data={d.daily.data} series={d.daily.series} rate={rate} />
                : <DailyBars data={d.daily.data} rate={rate} />}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Trạng thái máy" subtitle={`${d.devices.online + d.devices.idle + d.devices.offline + d.devices.banned} máy`} action={<Link to="/devices" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Xem tất cả</Link>} />
            <div className="px-5 pb-5"><DeviceBar devices={d.devices} /></div>
          </Card>
          <Card>
            <CardHeader title="Tài khoản" icon={Users} subtitle={`${d.accounts.total} tài khoản`} action={<Link to="/accounts" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Quản lý</Link>} />
            <div className="grid grid-cols-3 gap-2 px-5 pb-5 text-center">
              {[['running', 'Running', 'text-emerald-600 dark:text-emerald-400'], ['stopped', 'Stopped', 'text-amber-600 dark:text-amber-400'], ['banned', 'Banned', 'text-red-600 dark:text-red-400']].map(([k, l, c]) => (
                <Link key={k} to={`/accounts?filter=${k}`} className="rounded-xl bg-zinc-50 py-3 hover:bg-zinc-100 dark:bg-zinc-800/60 dark:hover:bg-zinc-800">
                  <div className={cx('text-xl font-semibold tabular', c)}>{d.accounts[k]}</div>
                  <div className="text-xs text-zinc-500">{l}</div>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Theo tài khoản / nhóm */}
      <Card className="mt-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <Layers className="size-[18px] text-zinc-400" />
            <div>
              <h3 className="text-[15px] font-semibold">{tableMode === 'accounts' ? 'Theo tài khoản' : 'Theo nhóm'}</h3>
              <p className="text-xs text-zinc-500">Bấm vào tiêu đề cột để sắp xếp{tableMode === 'accounts' ? ', bấm vào dòng để xem chi tiết' : ', bấm vào nhóm để lọc'}</p>
            </div>
          </div>
          {d.groups.length > 0 && <SegTabs value={tableMode} onChange={setTableMode} items={[['accounts', 'Tài khoản'], ['groups', 'Nhóm']]} />}
        </div>
        {tableMode === 'accounts' || !d.groups.length ? (
          <SortTable columns={accountCols} rows={d.rows} initialSort={{ key: 'today', dir: 'desc' }} onRowClick={r => navigate(`/accounts/${r.id}`)}
            empty={<Empty icon={Users} title="Không có tài khoản" />}
            footer={d.rows.length > 1 ? {
              name: `Tổng ${d.rows.length} tài khoản`, dev_online: `${totals.dev_total} máy`, today: usd(totals.today, 3), d7: usd(totals.d7, 2),
              usage_today: fmtBytes(totals.usage_today), uptime_today: <Uptime value={d.uptime_today} />, balance: usd(totals.balance), withdrawn: usd(totals.withdrawn), lifetime: usd(totals.lifetime),
            } : null} />
        ) : (
          <SortTable columns={groupCols} rows={d.groups} initialSort={{ key: 'today', dir: 'desc' }}
            onRowClick={r => r.group !== 'Chưa có nhóm' && scope.set({ group: r.group })} />
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader title="Hoạt động gần đây" icon={Bell} action={<span className="text-xs text-zinc-500">Uptime hôm nay: {pct(d.uptime_today)}</span>} />
        <EventList events={d.events} />
      </Card>
    </>
  );
}
