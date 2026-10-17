import { useEffect, useMemo, useRef, useState } from 'react';
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

function summarize(g, devices) {
  Object.assign(g, { devices, counts: {}, problems: 0, today: 0, usage: 0, earned: 0 });
  for (const d of devices) {
    g.counts[d.status] = (g.counts[d.status] || 0) + 1;
    if (isProblem(d)) g.problems++;
    g.today += d.today || 0;
    g.usage += d.usage_today || 0;
    g.earned += d.earned_total || 0;
  }
  return g;
}

function groupByAccount(devices) {
  const map = new Map();
  for (const d of devices) {
    if (!map.has(d.account_id)) map.set(d.account_id, { id: d.account_id, label: d.label, email: d.email, group_name: d.group_name, list: [] });
    map.get(d.account_id).list.push(d);
  }
  return [...map.values()].map(g => summarize(g, g.list));
}

// Máy = group_name của acc. Acc chưa gán máy gom chung một dòng, xếp cuối.
function groupByMachine(accounts) {
  const map = new Map();
  for (const a of accounts) {
    const name = a.group_name || '';
    if (!map.has(name)) map.set(name, { id: 'm:' + name, group_name: name, accounts: [] });
    map.get(name).accounts.push(a);
  }
  return [...map.values()].map(m => summarize(m, m.accounts.flatMap(a => a.devices)));
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

function GroupRow({ g, isOpen, toggle, title, sub, children }) {
  return (
    <div>
      <button onClick={() => toggle(g.id)} className="flex w-full cursor-pointer text-sm flex-col gap-1.5 px-4 py-3 text-left hover:bg-zinc-50/80 md:flex-row md:items-center md:gap-4 md:px-5 dark:hover:bg-zinc-800/40">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ChevronRight className={cx('size-4 shrink-0 text-zinc-400 transition', isOpen && 'rotate-90')} />
          {title}
          <span className="shrink-0 text-xs text-zinc-400 tabular">{sub}</span>
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
      {isOpen && children}
    </div>
  );
}

function GroupHeader({ first }) {
  return (
    <div className="hidden items-center gap-4 bg-zinc-50/70 px-5 py-2 text-[11px] font-medium uppercase tracking-[.05em] text-zinc-500 md:flex dark:bg-zinc-800/30">
      <span className="flex-1 pl-6">{first}</span>
      <span>Node</span>
      <span className="flex gap-4"><span>Hôm nay</span><span>Dung lượng</span><span className="w-20 text-right">Tổng kiếm</span></span>
    </div>
  );
}

function AccountRows({ groups, open, toggle, inMachine }) {
  return groups.map(g => (
    <GroupRow key={g.id} g={g} isOpen={open.has(g.id)} toggle={toggle}
      title={<AccName label={g.label} email={g.email} group={inMachine ? null : g.group_name} />} sub={`${g.devices.length} node`}>
      <div className="border-t border-zinc-100 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-950/30">
        <div className="px-5 pt-2 text-xs"><Link to={`/accounts/${g.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-300">Chi tiết tài khoản →</Link></div>
        <DeviceTable devices={g.devices} />
      </div>
    </GroupRow>
  ));
}

function AccountGroups({ groups, open, toggle }) {
  if (!groups.length) return <Empty icon={Server} title="Không có node nào" />;
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      <GroupHeader first="Tài khoản" />
      <AccountRows groups={groups} open={open} toggle={toggle} />
    </div>
  );
}

function MachineGroups({ machines, open, toggle }) {
  if (!machines.length) return <Empty icon={Server} title="Không có node nào" />;
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      <GroupHeader first="Máy" />
      {machines.map(m => (
        <GroupRow key={m.id} g={m} isOpen={open.has(m.id)} toggle={toggle}
          title={<span className="truncate font-semibold">{m.group_name || 'Chưa gán máy'}</span>}
          sub={`${m.accounts.length} acc · ${m.devices.length} node`}>
          <div className="divide-y divide-zinc-100 border-t border-zinc-100 bg-zinc-50/40 pl-4 md:pl-6 dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950/20">
            <AccountRows groups={m.accounts} open={open} toggle={toggle} inMachine />
          </div>
        </GroupRow>
      ))}
    </div>
  );
}

export default function Devices() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'all';
  const view = ['acc', 'list'].includes(params.get('view')) ? params.get('view') : 'machine';
  const sort = SORTS[params.get('sort')] ? params.get('sort') : 'problems';
  const group = params.get('group') || '';
  const [q, setQ] = useState('');
  // Mở từ trang Máy (?group=...): mở sẵn máy đó để thấy ngay các acc
  const [open, setOpen] = useState(() => new Set(params.get('group') ? ['m:' + params.get('group')] : []));
  const { data, loading } = useData(() => api('/devices'), [], 30000);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter(d => (status === 'all' || d.status === status) && (!group || d.group_name === group) &&
      (!s || [d.title, d.uuid, d.label, d.email, d.group_name, d.country].some(x => x?.toLowerCase().includes(s))))
      .sort((a, b) => byAccount(a, b) || a.title.localeCompare(b.title, 'vi', { numeric: true }));
  }, [data, q, status, group]);
  const groups = useMemo(() => sortGroups(groupByAccount(list), sort), [list, sort]);
  // Acc trong mỗi máy giữ đúng thứ tự sắp xếp đang chọn
  const machines = useMemo(() => sortGroups(groupByMachine(groups), sort), [groups, sort]);
  // Đang tìm thì mở sẵn các máy và acc khớp, xoá ô tìm thì thu gọn lại
  const firstQ = useRef(true);
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return; } // lần đầu vào trang giữ máy đang mở sẵn
    setOpen(new Set(q.trim() ? [...machines, ...groups].map(g => g.id) : []));
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <PageLoading />;
  const all = data || [];
  const inGroup = group ? all.filter(d => d.group_name === group) : all;
  const count = k => inGroup.filter(d => d.status === k).length;
  const accounts = new Set(all.map(d => d.account_id)).size;
  const groupNames = [...new Set(all.map(d => d.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
  const setParam = (k, v, def) => { v === def ? params.delete(k) : params.set(k, v); setParams(params, { replace: true }); };
  const toggle = id => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const shown = view === 'machine' ? machines : groups;
  const allOpen = shown.length > 0 && shown.every(g => open.has(g.id));

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
        <Tabs value={view} onChange={v => setParam('view', v, 'machine')} items={[
          { value: 'machine', label: 'Theo máy', count: machines.length },
          { value: 'acc', label: 'Theo acc', count: groups.length },
          { value: 'list', label: 'Tất cả node', count: list.length },
        ]} />
        {view !== 'list' && shown.length > 0 && (
          <div className="flex items-center gap-2">
            <select value={sort} onChange={e => setParam('sort', e.target.value, 'problems')} title="Sắp xếp" className="h-8 rounded-xl border-0 bg-white px-3 text-[13px] ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700 cursor-pointer">
              {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <Button variant="secondary" size="sm" icon={ChevronsUpDown} onClick={() => setOpen(prev => { const n = new Set(prev); shown.forEach(g => allOpen ? n.delete(g.id) : n.add(g.id)); return n; })}>
              {allOpen ? 'Thu gọn' : 'Mở hết'}
            </Button>
          </div>
        )}
      </div>
      <Card className="overflow-hidden">
        {view === 'machine' ? <MachineGroups machines={machines} open={open} toggle={toggle} />
          : view === 'acc' ? <AccountGroups groups={groups} open={open} toggle={toggle} />
          : <DeviceTable devices={list} showAccount />}
      </Card>
    </>
  );
}
