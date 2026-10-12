import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Server, Download, Info } from 'lucide-react';
import { api, usd, duration, timeAgo, fmtBytes, DEVICE_STATUS, countryCode } from '../lib';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Empty, DeviceBadge, useData } from '../ui';

const BAN_REASON = { earnapp_blacklist: 'IP nằm trong danh sách đen', ip_quality: 'IP chất lượng kém' };

function statusDetail(d) {
  if (d.status === 'banned') return BAN_REASON[d.banned_reason] || d.banned_reason;
  if (d.status === 'online' || d.status === 'idle') return d.online_since ? `Online ${duration(Date.now() - d.online_since)}` : 'Online';
  return d.last_online_at ? `Thấy lần cuối ${timeAgo(d.last_online_at)}` : 'Chưa từng online';
}

const Country = ({ c }) => c ? <span className="rounded bg-zinc-100 px-1 py-px text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800">{countryCode(c)}</span> : null;

export function DeviceTable({ devices, showAccount }) {
  if (!devices.length) return <Empty icon={Server} title="Không có máy nào" />;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500 dark:border-zinc-800">
              <th className="px-5 py-3 font-medium">Máy</th>
              {showAccount && <th className="px-3 py-3 font-medium">Tài khoản</th>}
              <th className="px-3 py-3 font-medium">Trạng thái</th>
              <th className="px-3 py-3 font-medium">Chi tiết</th>
              <th className="px-3 py-3 text-right font-medium">Hôm nay</th>
              <th className="px-3 py-3 text-right font-medium">Dung lượng hôm nay</th>
              <th className="px-3 py-3 text-right font-medium">Tổng kiếm</th>
              <th className="px-5 py-3 text-right font-medium">Thời gian chạy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {devices.map(d => (
              <tr key={d.uuid} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2 font-medium">{d.title}<Country c={d.country} /></div>
                  <div className="font-mono text-[11px] text-zinc-400">{d.uuid}</div>
                </td>
                {showAccount && <td className="max-w-48 truncate px-3 py-3"><Link to={`/accounts/${d.account_id}`} className="hover:text-indigo-600 hover:underline">{d.account}</Link></td>}
                <td className="px-3 py-3"><DeviceBadge status={d.status} /></td>
                <td className="px-3 py-3 text-xs text-zinc-500">{statusDetail(d)}</td>
                <td className="px-3 py-3 text-right tabular">{d.today != null ? usd(d.today, 3) : '—'}</td>
                <td className="px-3 py-3 text-right tabular">{fmtBytes(d.usage_today)}</td>
                <td className="px-3 py-3 text-right font-medium tabular">{usd(d.earned_total, 3)}</td>
                <td className="px-5 py-3 text-right text-zinc-500 tabular">{duration(d.total_uptime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
        {devices.map(d => (
          <li key={d.uuid} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 font-medium"><span className="truncate">{d.title}</span><Country c={d.country} /></span>
              <DeviceBadge status={d.status} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-zinc-500">
              <span className="truncate">{showAccount ? d.account : statusDetail(d)}</span>
              <span className="tabular">{fmtBytes(d.usage_today)} · {usd(d.earned_total, 3)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500">
      <Info className="size-3.5" />
      {Object.entries(DEVICE_STATUS).map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-full ${v.color}`} /><span><b className="font-medium text-zinc-600 dark:text-zinc-300">{v.label}</b>: {v.hint.toLowerCase()}</span></span>
      ))}
    </div>
  );
}

export default function Devices() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'all';
  const [q, setQ] = useState('');
  const { data, loading } = useData(() => api('/devices'), [], 30000);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter(d => (status === 'all' || d.status === status) &&
      (!s || [d.title, d.uuid, d.account, d.country].some(x => x?.toLowerCase().includes(s))));
  }, [data, q, status]);

  if (loading && !data) return <PageLoading />;
  const all = data || [];
  const count = k => all.filter(d => d.status === k).length;

  return (
    <>
      <PageHeader title="Máy (Node)" subtitle={`${all.length} máy trên tất cả tài khoản`}>
        <a href="/api/export/devices"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
      </PageHeader>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={status} onChange={v => { v === 'all' ? params.delete('status') : params.set('status', v); setParams(params, { replace: true }); }} items={[
          { value: 'all', label: 'Tất cả', count: all.length },
          ...Object.entries(DEVICE_STATUS).map(([k, v]) => ({ value: k, label: v.label, count: count(k), dot: v.color })),
        ]} />
        <SearchInput value={q} onChange={setQ} placeholder="Tìm tên máy, tài khoản…" className="lg:w-72" />
      </div>
      <Card className="overflow-hidden"><DeviceTable devices={list} showAccount /></Card>
      <div className="mt-3 px-1"><StatusLegend /></div>
    </>
  );
}
