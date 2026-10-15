import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Server, Download, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { api, usd, duration, timeAgo, fmtBytes, DEVICE_STATUS, countryCode } from '../lib';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Empty, DeviceBadge, StatusDot, AccName, byAccount, useData, cx } from '../ui';

const BAN_REASON = { earnapp_blacklist: 'IP nằm trong danh sách đen', ip_quality: 'IP chất lượng kém' };

function statusDetail(d) {
  if (d.status === 'unknown') return `Dữ liệu cũ, cập nhật lần cuối ${timeAgo(d.updated_at)}`;
  if (d.status === 'banned') return BAN_REASON[d.banned_reason] || d.banned_reason;
  if (d.status === 'online' || d.status === 'idle') return d.online_since ? `Online ${duration(Date.now() - d.online_since)}` : 'Online';
  return d.last_online_at ? `Thấy lần cuối ${timeAgo(d.last_online_at)}` : 'Chưa từng online';
}

const Country = ({ c }) => c ? <span className="rounded bg-zinc-100 px-1 py-px text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800">{countryCode(c)}</span> : null;

export function DeviceTable({ devices, showAccount }) {
  if (!devices.length) return <Empty icon={Server} title="Không có node nào" />;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500 dark:border-zinc-800">
              <th className="px-5 py-3 font-medium">Node</th>
              {showAccount && <th className="px-3 py-3 font-medium">Tài khoản</th>}
              <th className="px-3 py-3 font-medium">Trạng thái</th>
              <th className="px-3 py-3 font-medium">Chi tiết</th>
              <th className="px-3 py-3 text-right font-medium">Hôm nay</th>
              <th className="px-3 py-3 text-right font-medium">Dung lượng</th>
              <th className="px-3 py-3 text-right font-medium">Tổng kiếm</th>
              <th className="px-5 py-3 text-right font-medium">Đã chạy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {devices.map(d => (
              <tr key={d.uuid} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2 font-medium">{d.title}<Country c={d.country} /></div>
                  <div className="font-mono text-[11px] text-zinc-400">{d.uuid}</div>
                </td>
                {showAccount && <td className="max-w-56 px-3 py-3"><Link to={`/accounts/${d.account_id}`} className="block hover:text-indigo-600"><AccName small label={d.label} email={d.email} group={d.group_name} /></Link></td>}
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
              <span className="truncate">{showAccount ? d.label || d.email : statusDetail(d)}</span>
              <span className="tabular">{fmtBytes(d.usage_today)} · {usd(d.earned_total, 3)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

const STATUS_ORDER = ['online', 'idle', 'offline', 'banned', 'unknown'];
// Node cần để ý: rớt mạng, lâu không tăng tiền, chưa rõ
const isProblem = d => d.status === 'offline' || d.status === 'idle' || d.status === 'unknown';

function groupByAccount(devices) {
  const map = new Map();
  for (const d of devices) {
    let g = map.get(d.account_id);
    if (!g) map.set(d.account_id, g = { id: d.account_id, label: d.label, email: d.email, group_name: d.group_name, devices: [], counts: {}, problems: 0, today: 0, usage: 0, earned: 0 });
    g.devices.push(d);
    g.counts[d.status] = (g.counts[d.status] || 0) + 1;
    if (isProblem(d)) g.problems++;
    g.today += d.today || 0;
    g.usage += d.usage_today || 0;
    g.earned += d.earned_total || 0;
  }
  return [...map.values()];
}

const SORTS = {
  problems: { label: 'Nhiều node cần xem', key: g => g.problems },
  name: { label: 'Theo máy, tên' },
  devices: { label: 'Nhiều node nhất', key: g => g.devices.length },
  today: { label: 'Hôm nay kiếm nhiều', key: g => g.today },
  usage: { label: 'Dung lượng hôm nay', key: g => g.usage },
  earned: { label: 'Tổng kiếm nhiều', key: g => g.earned },
};

function sortGroups(groups, sort) {
  const key = SORTS[sort].key;
  return [...groups].sort((a, b) => (key ? key(b) - key(a) : 0) || byAccount(a, b));
}

function StatusCounts({ counts }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {STATUS_ORDER.filter(k => counts[k]).map(k => (
        <span key={k} className="inline-flex items-center gap-1 text-[13px] tabular" title={DEVICE_STATUS[k].label}><StatusDot status={k} size="sm" />{counts[k]}</span>
      ))}
    </div>
  );
}

function AccountGroups({ groups, open, toggle }) {
  if (!groups.length) return <Empty icon={Server} title="Không có node nào" />;
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      <div className="hidden items-center gap-4 bg-zinc-50/70 px-5 py-2 text-[11px] font-medium uppercase tracking-[.05em] text-zinc-500 md:flex dark:bg-zinc-800/30">
        <span className="flex-1 pl-6">Tài khoản</span>
        <span>Node</span>
        <span className="flex gap-4"><span>Hôm nay</span><span>Dung lượng</span><span className="w-20 text-right">Tổng kiếm</span></span>
      </div>
      {groups.map(g => {
        const isOpen = open.has(g.id);
        return (
          <div key={g.id}>
            <button onClick={() => toggle(g.id)} className="flex w-full cursor-pointer text-sm flex-col gap-1.5 px-4 py-3 text-left hover:bg-zinc-50/80 md:flex-row md:items-center md:gap-4 md:px-5 dark:hover:bg-zinc-800/40">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <ChevronRight className={cx('size-4 shrink-0 text-zinc-400 transition', isOpen && 'rotate-90')} />
                <AccName label={g.label} email={g.email} group={g.group_name} />
                <span className="shrink-0 text-xs text-zinc-400 tabular">{g.devices.length} node</span>
                {g.problems > 0 && <span className="shrink-0 text-xs font-medium text-bad">{g.problems} cần xem</span>}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 pl-6 md:pl-0">
                <StatusCounts counts={g.counts} />
                <div className="flex gap-4 text-xs text-zinc-500 tabular">
                  <span title="Hôm nay">{usd(g.today, 3)}</span>
                  <span title="Dung lượng hôm nay" className="hidden sm:inline">{fmtBytes(g.usage)}</span>
                  <span className="w-20 text-right font-medium text-zinc-700 dark:text-zinc-200" title="Tổng kiếm">{usd(g.earned, 3)}</span>
                </div>
              </div>
            </button>
            {isOpen && (
              <div className="border-t border-zinc-100 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-950/30">
                <div className="px-5 pt-2 text-xs"><Link to={`/accounts/${g.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-300">Chi tiết tài khoản →</Link></div>
                <DeviceTable devices={g.devices} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Devices() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'all';
  const view = params.get('view') === 'list' ? 'list' : 'group';
  const sort = SORTS[params.get('sort')] ? params.get('sort') : 'problems';
  const group = params.get('group') || '';
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const { data, loading } = useData(() => api('/devices'), [], 30000);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter(d => (status === 'all' || d.status === status) && (!group || d.group_name === group) &&
      (!s || [d.title, d.uuid, d.label, d.email, d.group_name, d.country].some(x => x?.toLowerCase().includes(s))))
      .sort((a, b) => byAccount(a, b) || a.title.localeCompare(b.title, 'vi', { numeric: true }));
  }, [data, q, status, group]);
  const groups = useMemo(() => sortGroups(groupByAccount(list), sort), [list, sort]);
  // Đang tìm thì mở sẵn các acc khớp, xoá ô tìm thì thu gọn lại
  useEffect(() => { setOpen(new Set(q.trim() ? groups.map(g => g.id) : [])); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <PageLoading />;
  const all = data || [];
  const inGroup = group ? all.filter(d => d.group_name === group) : all;
  const count = k => inGroup.filter(d => d.status === k).length;
  const accounts = new Set(all.map(d => d.account_id)).size;
  const groupNames = [...new Set(all.map(d => d.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
  const setParam = (k, v, def) => { v === def ? params.delete(k) : params.set(k, v); setParams(params, { replace: true }); };
  const toggle = id => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOpen = groups.length > 0 && groups.every(g => open.has(g.id));

  return (
    <>
      <PageHeader title="Node" subtitle={`${all.length} node · ${accounts} tài khoản`}>
        <a href="/api/export/devices"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
      </PageHeader>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={status} onChange={v => setParam('status', v, 'all')} items={[
          { value: 'all', label: 'Tất cả', count: inGroup.length },
          ...Object.entries(DEVICE_STATUS).map(([k, v]) => ({ value: k, label: v.label, count: count(k), mark: <StatusDot status={k} size="sm" /> })),
        ]} />
        <div className="flex gap-2">
          {groupNames.length > 0 && (
            <select value={group} onChange={e => setParam('group', e.target.value, '')} className="h-9 rounded-xl border-0 bg-white px-3 text-sm ring-1 ring-inset ring-zinc-300/80 dark:bg-zinc-800/60 dark:ring-zinc-700 cursor-pointer">
              <option value="">Tất cả máy</option>
              {groupNames.map(g => <option key={g}>{g}</option>)}
            </select>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Tìm node, tên, email…" className="w-full lg:w-72" />
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs value={view} onChange={v => setParam('view', v, 'group')} items={[
          { value: 'group', label: 'Theo acc', count: groups.length },
          { value: 'list', label: 'Tất cả node', count: list.length },
        ]} />
        {view === 'group' && groups.length > 0 && (
          <div className="flex items-center gap-2">
            <select value={sort} onChange={e => setParam('sort', e.target.value, 'problems')} title="Sắp xếp tài khoản" className="h-8 rounded-xl border-0 bg-white px-3 text-[13px] ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700 cursor-pointer">
              {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <Button variant="secondary" size="sm" icon={ChevronsUpDown} onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map(g => g.id)))}>
              {allOpen ? 'Thu gọn' : 'Mở hết'}
            </Button>
          </div>
        )}
      </div>
      <Card className="overflow-hidden">
        {view === 'group' ? <AccountGroups groups={groups} open={open} toggle={toggle} /> : <DeviceTable devices={list} showAccount />}
      </Card>
    </>
  );
}
