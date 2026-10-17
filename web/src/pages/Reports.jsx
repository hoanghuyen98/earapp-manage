import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Trash2, PiggyBank, Users, Download, Info } from 'lucide-react';
import { api, usd, vnd, fmtBytes } from '../lib';
import { Card, CardHeader, Button, PageHeader, PageLoading, Modal, Field, Input, Select, Empty, DeviceBadge, AccountBadge, AccName, nameKey, byAccount, useData, useToast, cx } from '../ui';
import { ProfitBars, DailyBars, UsageBars } from '../charts';
import { StatStrip } from './Dashboard';
import { useScope, ScopeFilter, SortTable, Delta, Uptime, ShareBar, SegTabs, pct } from '../components';

const fmtD = d => d.split('-').reverse().join('/');
const ymd = dt => dt.toISOString().slice(0, 10);

function presetRange(key) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const back = n => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return ymd(d); };
  if (key === 'month') return { from: ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: ymd(today) };
  if (key === 'last_month') return { from: ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))), to: ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))) };
  const n = { '7': 7, '30': 30, '90': 90 }[key] || 30;
  return { from: back(n - 1), to: ymd(today) };
}

function CostModal({ open, onClose, onSaved }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ name: '', amount: '', period: 'monthly', date: today, note: '' });
  const [loading, setLoading] = useState(false);
  const amountNum = Number(String(form.amount).replace(/\D/g, ''));
  const save = async () => {
    setLoading(true);
    try {
      await api('/costs', { method: 'POST', body: { ...form, amount: amountNum } });
      toast('Đã thêm chi phí');
      setForm({ name: '', amount: '', period: 'monthly', date: today, note: '' });
      onSaved(); onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setLoading(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Thêm chi phí"
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button><Button loading={loading} onClick={save}>Thêm</Button></>}>
      <div className="space-y-4">
        <Field label="Tên chi phí"><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="VD: Tiền VPS, proxy, điện, mua acc…" autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Số tiền (VNĐ)" hint={amountNum ? vnd(amountNum) : ''}>
            <Input inputMode="numeric" value={form.amount ? amountNum.toLocaleString('vi-VN') : ''} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="150.000" />
          </Field>
          <Field label="Loại">
            <Select value={form.period} onChange={e => setForm({ ...form, period: e.target.value })}>
              <option value="monthly">Hằng tháng</option>
              <option value="once">Một lần</option>
            </Select>
          </Field>
        </div>
        <Field label={form.period === 'monthly' ? 'Bắt đầu từ ngày' : 'Ngày chi'}><Input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function Section({ title, icon, subtitle, action, children, className }) {
  return (
    <Card className={cx('mt-4 overflow-hidden', className)}>
      <CardHeader title={title} icon={icon} subtitle={subtitle} action={action} />
      {children}
    </Card>
  );
}

export default function Reports() {
  const toast = useToast();
  const navigate = useNavigate();
  const scope = useScope();
  const [preset, setPreset] = useState('30');
  const [range, setRange] = useState(presetRange('30'));
  const [metric, setMetric] = useState('earn');
  const [adding, setAdding] = useState(false);
  const [allDevices, setAllDevices] = useState(false);
  const qs = `from=${range.from}&to=${range.to}&${scope.qs}`;
  const { data: r, loading, reload } = useData(() => api('/report?' + qs), [qs]);

  const choose = key => { setPreset(key); if (key !== 'custom') setRange(presetRange(key)); };

  const avgDev = useMemo(() => {
    const act = (r?.devices || []).filter(d => d.status !== 'banned');
    return act.length ? act.reduce((s, d) => s + d.per_day, 0) / act.length : 0;
  }, [r]);

  if (loading && !r) return <PageLoading />;
  if (!r) return null;
  const s = r.summary;
  const rate = r.usd_vnd;
  const delCost = async id => { await api('/costs/' + id, { method: 'DELETE' }); toast('Đã xoá'); reload(); };

  const accTotals = r.accounts.reduce((t, a) => {
    for (const k of ['earned', 'prev_earned', 'usage', 'devices', 'payouts', 'balance']) t[k] = (t[k] || 0) + (a[k] || 0);
    return t;
  }, {});

  const accCols = [
    { key: 'name', label: 'Tài khoản', sort: nameKey, render: a => <AccName className="max-w-64" label={a.label} email={a.email} group={a.group} /> },
    { key: 'status', label: 'Trạng thái', hide: 'lg', render: a => <AccountBadge status={a.status} /> },
    { key: 'earned', label: 'Thu nhập', align: 'right', render: a => <><span className="font-semibold">{usd(a.earned, 3)}</span><div className="text-xs text-zinc-500"><Delta now={a.earned} prev={a.prev_earned} /></div></> },
    { key: 'share', label: 'Tỷ trọng', align: 'right', hide: 'md', render: a => <ShareBar value={a.share} /> },
    { key: 'usage', label: 'Dung lượng', align: 'right', hide: 'md', render: a => fmtBytes(a.usage) },
    { key: 'per_gb', label: '$/GB', align: 'right', hide: 'lg', title: 'Tiền kiếm được trên mỗi GB', render: a => a.per_gb == null ? '—' : usd(a.per_gb, 3) },
    { key: 'devices', label: 'Node', align: 'right', hide: 'sm', title: 'Số node đang hoạt động (không tính node bị ban)' },
    { key: 'per_device_day', label: '$/node/ngày', align: 'right', hide: 'xl', render: a => a.per_device_day == null ? '—' : usd(a.per_device_day, 4) },
    { key: 'uptime', label: 'Online', align: 'right', hide: 'lg', render: a => <Uptime value={a.uptime} /> },
    { key: 'payouts', label: 'Tiền về', align: 'right', hide: 'xl', title: 'Số tiền rút đã về trong kỳ', render: a => a.payouts ? usd(a.payouts) : '—' },
    { key: 'balance', label: 'Số dư', align: 'right', render: a => usd(a.balance) },
  ];

  const groupCols = [
    { key: 'group', label: 'Máy', render: g => <span className="font-medium">{g.group}</span> },
    { key: 'accounts', label: 'Số acc', align: 'right' },
    { key: 'earned', label: 'Thu nhập', align: 'right', render: g => <><span className="font-semibold">{usd(g.earned, 3)}</span> <Delta now={g.earned} prev={g.prev_earned} /></> },
    { key: 'share', label: 'Tỷ trọng', align: 'right', hide: 'sm', render: g => <ShareBar value={g.share} /> },
    { key: 'usage', label: 'Dung lượng', align: 'right', hide: 'md', render: g => fmtBytes(g.usage) },
    { key: 'per_gb', label: '$/GB', align: 'right', hide: 'md', render: g => g.per_gb == null ? '—' : usd(g.per_gb, 3) },
    { key: 'devices', label: 'Node', align: 'right' },
    { key: 'balance', label: 'Số dư', align: 'right', render: g => usd(g.balance) },
  ];

  const devCols = [
    { key: 'rank', label: '#', sortable: false, className: 'text-zinc-400 tabular w-10', render: (d, i) => i + 1 },
    { key: 'title', label: 'Node', sort: d => d.title, render: d => <><div className="font-medium">{d.title}</div><div className="text-[11px] text-zinc-400">{(d.country || '').toUpperCase()}</div></> },
    { key: 'account', label: 'Tài khoản', hide: 'md', sort: nameKey, render: d => <Link to={`/accounts/${d.account_id}`} onClick={e => e.stopPropagation()} className="block max-w-56 text-zinc-600 hover:text-indigo-600 dark:text-zinc-300"><AccName small label={d.label} email={d.email} group={d.group_name} /></Link> },
    { key: 'status', label: 'Trạng thái', hide: 'lg', render: d => <DeviceBadge status={d.status} /> },
    { key: 'earned', label: 'Thu nhập', align: 'right', render: d => <span className="font-semibold">{usd(d.earned, 3)}</span> },
    { key: 'per_day', label: 'TB/ngày', align: 'right', hide: 'sm', render: d => usd(d.per_day, 4) },
    { key: 'usage', label: 'Dung lượng', align: 'right', hide: 'md', render: d => fmtBytes(d.usage) },
    { key: 'per_gb', label: '$/GB', align: 'right', hide: 'lg', render: d => d.per_gb == null ? '—' : usd(d.per_gb, 3) },
    { key: 'uptime', label: 'Online', align: 'right', hide: 'sm', render: d => <Uptime value={d.uptime} /> },
  ];
  const weak = r.devices.filter(d => d.status !== 'banned' && avgDev > 0 && d.per_day < avgDev * 0.5);

  const months = r.months.map(m => ({ ...m, income_vnd: Math.round(m.earned * rate) }));
  // Chỉ hiện các tháng có số liệu (thu nhập, dung lượng, tiền về hoặc chi phí); luôn giữ tháng hiện tại
  const monthsShown = months.filter((m, i) => i === months.length - 1 || m.has_data || m.usage || m.payouts || m.cost_vnd);
  const monthCols = [
    { key: 'month', label: 'Tháng', sort: m => m.month, render: m => <span className={cx('font-medium', !m.has_data && 'text-zinc-400')}>{`T${Number(m.month.slice(5))}/${m.month.slice(0, 4)}`}</span> },
    { key: 'earned', label: 'Thu nhập', align: 'right', render: m => m.has_data ? <><span className="font-semibold">{usd(m.earned)}</span><div className="text-xs text-zinc-500">≈ {vnd(m.income_vnd)}</div></> : <span className="text-zinc-400">—</span> },
    { key: 'usage', label: 'Dung lượng', align: 'right', render: m => m.usage ? fmtBytes(m.usage) : <span className="text-zinc-400">—</span> },
    { key: 'payouts', label: 'Tiền về', align: 'right', hide: 'sm', render: m => m.payouts ? usd(m.payouts) : '—' },
    ...(r.scope_all ? [
      { key: 'cost_vnd', label: 'Chi phí', align: 'right', hide: 'sm', render: m => m.cost_vnd ? vnd(m.cost_vnd) : '—' },
      { key: 'profit_vnd', label: 'Lãi', align: 'right', render: m => m.has_data || m.cost_vnd ? <span className={cx('font-semibold', m.profit_vnd < 0 && 'text-red-600 dark:text-red-400')}>{vnd(m.profit_vnd)}</span> : '—' },
    ] : []),
  ];

  const countryCols = [
    { key: 'country', label: 'Quốc gia', render: c => <span className="font-medium">{c.country}</span> },
    { key: 'devices', label: 'Số node', align: 'right' },
    { key: 'active', label: 'Đang chạy', align: 'right' },
    { key: 'earned', label: 'Thu nhập', align: 'right', render: c => usd(c.earned, 3) },
    { key: 'usage', label: 'Dung lượng', align: 'right', hide: 'sm', render: c => fmtBytes(c.usage) },
    { key: 'per_gb', label: '$/GB', align: 'right', hide: 'sm', render: c => c.per_gb == null ? '—' : usd(c.per_gb, 3) },
  ];

  const exportUrl = `/api/export/report?${qs}`;
  const missingData = r.data_since && r.data_since > r.from;

  return (
    <>
      <PageHeader title="Báo cáo">
        <ScopeFilter scope={scope} />
        <a href={exportUrl}><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
      </PageHeader>

      {/* Khoảng thời gian */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <SegTabs size="md" value={preset} onChange={choose} items={[['7', '7 ngày'], ['30', '30 ngày'], ['90', '90 ngày'], ['month', 'Tháng này'], ['last_month', 'Tháng trước'], ['custom', 'Tuỳ chọn']]} />
        </div>
        {preset === 'custom' ? (
          <div className="flex items-center gap-2">
            <Input type="date" value={range.from} max={range.to} onChange={e => setRange({ ...range, from: e.target.value })} className="w-40 h-9 py-0" />
            <span className="text-zinc-400">→</span>
            <Input type="date" value={range.to} min={range.from} onChange={e => setRange({ ...range, to: e.target.value })} className="w-40 h-9 py-0" />
          </div>
        ) : (
          <div className="text-[13px] text-zinc-500" title={`So với ${fmtD(r.prev.from)} → ${fmtD(r.prev.to)}`}>
            <span className="text-zinc-800 dark:text-zinc-200">{fmtD(r.from)} → {fmtD(r.to)}</span> · {r.days} ngày
          </div>
        )}
      </div>

      {missingData && (
        <div className="mb-4 flex items-center gap-2 text-[13px] text-zinc-500">
          <Info className="size-4 shrink-0" />
          <span>Thu nhập theo ngày chỉ có từ {fmtD(r.data_since)}, tổng kỳ này có thể thấp hơn thực tế.</span>
        </div>
      )}

      <StatStrip items={[
        { label: 'Thu nhập', big: true, value: usd(s.earned, 2), right: <Delta now={s.earned} prev={s.prev_earned} />, sub: `Kỳ trước ${usd(s.prev_earned, 2)}`, title: `≈ ${vnd(s.income_vnd)}` },
        { label: 'Trung bình/ngày', big: true, value: usd(s.avg_per_day, 3), sub: `${s.data_days} ngày có số liệu` },
        { label: 'Dung lượng', big: true, value: fmtBytes(s.usage), right: <Delta now={s.usage} prev={s.prev_usage} />, sub: s.per_gb == null ? null : `${usd(s.per_gb, 3)}/GB` },
        { label: 'Online trung bình', big: true, value: pct(s.uptime, 1), sub: 'Không tính node bị ban' },
      ]} />
      <StatStrip className="mt-3" items={[
        { label: 'Tiền về', value: usd(s.payouts), sub: `${s.payouts_count} lệnh` },
        { label: 'Chi phí', value: s.cost_vnd == null ? '—' : vnd(s.cost_vnd), sub: s.cost_vnd == null ? 'Bỏ lọc để xem' : null },
        { label: 'Lãi', value: s.profit_vnd == null ? '—' : <span className={s.profit_vnd < 0 ? 'text-bad' : ''}>{vnd(s.profit_vnd)}</span>, sub: s.profit_vnd == null ? 'Bỏ lọc để xem' : null },
        { label: 'Tài khoản', value: r.accounts.length, sub: `${r.devices.filter(d => d.status === 'online' || d.status === 'idle').length} node online` },
      ]} />

      {/* Biểu đồ theo ngày */}
      <Card className="mt-4">
        <div className="px-5 pt-4">
          <SegTabs size="md" value={metric} onChange={setMetric} items={[['earn', 'Thu nhập'], ['usage', 'Dung lượng']]} />
        </div>
        <div className="px-3 pb-4 pt-3">
          {metric === 'earn' ? <DailyBars data={r.daily} rate={rate} /> : <UsageBars data={r.daily.map(x => ({ date: x.date, value: x.usage }))} />}
        </div>
      </Card>

      {/* Theo máy trước, bấm vào máy để lọc các acc của máy */}
      {r.groups.length > 0 && (
        <Section title="Theo máy">
          <SortTable columns={groupCols} rows={r.groups} initialSort={{ key: 'earned', dir: 'desc' }} onRowClick={g => g.group !== 'Chưa gán máy' && scope.set({ group: g.group })} />
        </Section>
      )}

      {/* Theo tài khoản */}
      <Section title="Theo tài khoản">
        <SortTable columns={accCols} rows={[...r.accounts].sort(byAccount)} initialSort={{ key: 'earned', dir: 'desc' }} onRowClick={a => navigate(`/accounts/${a.id}`)}
          empty={<Empty icon={Users} title="Không có tài khoản" />}
          footer={r.accounts.length > 1 ? {
            name: `Tổng ${r.accounts.length} acc`,
            earned: <>{usd(accTotals.earned, 3)} <Delta now={accTotals.earned} prev={accTotals.prev_earned} /></>,
            usage: fmtBytes(accTotals.usage), per_gb: s.per_gb == null ? '—' : usd(s.per_gb, 3), devices: accTotals.devices,
            uptime: <Uptime value={s.uptime} />, payouts: usd(accTotals.payouts), balance: usd(accTotals.balance),
          } : null} />
      </Section>

      {/* Theo tháng + lãi lỗ */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Section className="lg:col-span-3" title="Theo tháng">
          <SortTable columns={monthCols} rows={[...monthsShown].reverse()} initialSort={{ key: 'month', dir: 'desc' }} />
          
        </Section>
        <Section className="lg:col-span-2" title="Lãi lỗ" subtitle={<>$1 = {vnd(rate)} · <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-[var(--chart-1)]" />lãi</span> <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-[var(--chart-2)]" />lỗ</span></>}>
          {r.scope_all ? <div className="px-3 pb-4"><ProfitBars data={months.slice(-6)} height={240} /></div>
            : <Empty icon={PiggyBank} title="Bỏ lọc tài khoản để xem lãi lỗ" />}
        </Section>
      </div>

      {/* Xếp hạng node */}
      <Section title="Xếp hạng node"
        subtitle={<>TB {usd(avgDev, 4)}/node/ngày{weak.length > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{weak.length} node dưới nửa mức TB (tô vàng)</span></>}</>}>
        <SortTable columns={devCols} rows={allDevices ? r.devices : r.devices.slice(0, 15)} initialSort={{ key: 'earned', dir: 'desc' }}
          rowClass={d => d.status !== 'banned' && avgDev > 0 && d.per_day < avgDev * 0.5 ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''}
          empty={<Empty title="Chưa có node" />} />
        {r.devices.length > 15 && (
          <button onClick={() => setAllDevices(!allDevices)} className="w-full border-t border-zinc-100 py-2.5 text-sm font-medium text-indigo-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-indigo-400 dark:hover:bg-zinc-800/40 cursor-pointer">
            {allDevices ? 'Thu gọn' : `Xem cả ${r.devices.length} node`}
          </button>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Theo quốc gia */}
        <Section title="Theo quốc gia">
          <SortTable columns={countryCols} rows={r.countries} initialSort={{ key: 'earned', dir: 'desc' }} empty={<Empty title="Chưa có dữ liệu" />} />
        </Section>

        {/* Chi phí */}
        <Section title="Chi phí" action={<Button size="sm" icon={Plus} onClick={() => setAdding(true)}>Thêm</Button>}>
          {r.costs.length === 0 ? (
            <Empty title="Chưa có chi phí" />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {r.costs.map(c => (
                <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-zinc-500">{c.period === 'monthly' ? `Hằng tháng, từ ${fmtD(c.date)}` : `Một lần, ngày ${fmtD(c.date)}`}</div>
                  </div>
                  <div className="font-semibold tabular">{vnd(c.amount)}{c.period === 'monthly' && <span className="text-xs font-normal text-zinc-500">/tháng</span>}</div>
                  <button onClick={() => delCost(c.id)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 cursor-pointer"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <CostModal open={adding} onClose={() => setAdding(false)} onSaved={reload} />
    </>
  );
}
