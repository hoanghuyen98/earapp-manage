import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Check, Users, X, ArrowUp, ArrowDown, ArrowUpRight, ArrowDownRight, Search } from 'lucide-react';
import { api } from './lib';
import { cx } from './ui';

// ---------- Phạm vi lọc (tài khoản / máy), lưu trên URL + nhớ giữa các trang ----------
export function useScope() {
  const [params, setParams] = useSearchParams();
  const acc = params.get('acc') || '';
  const group = params.get('group') || '';

  // Mở trang không có bộ lọc trên URL thì lấy lại bộ lọc lần trước
  useEffect(() => {
    if (acc || group) return;
    try {
      const saved = JSON.parse(localStorage.getItem('scope') || '{}');
      if (saved.acc || saved.group) {
        if (saved.acc) params.set('acc', saved.acc);
        if (saved.group) params.set('group', saved.group);
        setParams(params, { replace: true });
      }
    } catch { /* bỏ qua */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next) => {
    for (const k of ['acc', 'group']) {
      if (next[k]) params.set(k, next[k]); else params.delete(k);
    }
    localStorage.setItem('scope', JSON.stringify({ acc: next.acc || '', group: next.group || '' }));
    setParams(params, { replace: true });
  };
  const qs = new URLSearchParams({ ...(acc && { acc }), ...(group && { group }) }).toString();
  return { acc, group, set, qs, active: !!(acc || group) };
}

export function ScopeFilter({ scope }) {
  const [opts, setOpts] = useState({ accounts: [], groups: [] });
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef();
  useEffect(() => { api('/scope').then(setOpts).catch(() => {}); }, []);
  useEffect(() => {
    if (!open) return;
    const h = e => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const selected = scope.acc ? scope.acc.split(',').map(Number) : [];
  const toggle = id => {
    const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
    scope.set({ acc: next.join(','), group: scope.group });
  };
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return opts.accounts.filter(a => (!scope.group || a.group === scope.group) && (!s || [a.name, a.email, a.group].some(x => x?.toLowerCase().includes(s))));
  }, [opts, q, scope.group]);

  let label = 'Tất cả tài khoản';
  if (selected.length === 1) label = opts.accounts.find(a => a.id === selected[0])?.name || '1 tài khoản';
  else if (selected.length > 1) label = `${selected.length} tài khoản`;
  if (scope.group) label = selected.length ? `${scope.group} · ${label}` : `Máy ${scope.group}`;

  return (
    <div className="relative" ref={ref}>
      <div className="flex items-center">
        <button onClick={() => setOpen(!open)}
          className={cx('flex h-9 max-w-64 items-center gap-2 rounded-xl px-3 text-sm font-medium ring-1 ring-inset transition cursor-pointer',
            scope.active ? 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/30' : 'bg-white text-zinc-700 ring-zinc-300/80 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700')}>
          <Users className="size-4 shrink-0 opacity-60" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-60" />
        </button>
        {scope.active && (
          <button onClick={() => scope.set({})} title="Bỏ lọc" className="ml-1 rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 cursor-pointer"><X className="size-4" /></button>
        )}
      </div>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-2xl border border-zinc-200 bg-white p-3 shadow-lg animate-fade-in dark:border-zinc-700 dark:bg-zinc-900">
          {opts.groups.length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 text-xs font-medium text-zinc-500">Máy</div>
              <div className="flex flex-wrap gap-1.5">
                {['', ...opts.groups].map(g => (
                  <button key={g || 'all'} onClick={() => scope.set({ acc: '', group: g })}
                    className={cx('rounded-lg px-2.5 py-1 text-xs font-medium cursor-pointer', scope.group === g ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300')}>
                    {g || 'Tất cả'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm tài khoản…" autoFocus
              className="w-full rounded-lg bg-zinc-100 py-1.5 pl-8 pr-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-zinc-800" />
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {list.map(a => (
              <li key={a.id}>
                <button onClick={() => toggle(a.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer">
                  <span className={cx('flex size-4 shrink-0 items-center justify-center rounded border', selected.includes(a.id) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-zinc-300 dark:border-zinc-600')}>
                    {selected.includes(a.id) && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{a.name}</span>
                    {a.name !== a.email && <span className="block truncate text-xs text-zinc-500">{a.email}</span>}
                  </span>
                  {a.group && <span className="shrink-0 rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{a.group}</span>}
                </button>
              </li>
            ))}
            {!list.length && <li className="px-2 py-4 text-center text-sm text-zinc-500">Không có tài khoản</li>}
          </ul>
          {selected.length > 0 && (
            <button onClick={() => scope.set({ acc: '', group: scope.group })} className="mt-2 w-full rounded-lg py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10 cursor-pointer">Bỏ chọn tài khoản</button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Bảng sắp xếp được ----------
/**
 * columns: [{ key, label, align, render(row), sort(row) -> giá trị so sánh, className, hide: 'sm'|'md'|'lg' }]
 */
export function SortTable({ columns, rows, initialSort, onRowClick, footer, rowClass, empty }) {
  const [sort, setSort] = useState(initialSort || { key: columns[0].key, dir: 'desc' });
  const hideCls = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' };
  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort.key);
    if (!col) return rows;
    const val = col.sort || (r => r[col.key]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y, 'vi', { numeric: true }) : x - y;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, sort, columns]);
  if (!rows.length) return empty || null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50/70 text-[11px] uppercase tracking-[.05em] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/30">
            {columns.map((c, i) => (
              <th key={c.key} className={cx('py-2 font-medium whitespace-nowrap', i === 0 ? 'pl-5 pr-3' : i === columns.length - 1 ? 'pl-3 pr-5' : 'px-3', c.align === 'right' ? 'text-right' : 'text-left', hideCls[c.hide])}>
                {c.sortable === false ? c.label : (
                  <button onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                    className={cx('inline-flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer', sort.key === c.key && 'text-zinc-800 dark:text-zinc-200')} title={c.title}>
                    {c.label}
                    {sort.key === c.key && (sort.dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sorted.map((r, ri) => (
            <tr key={r.id ?? r.uuid ?? r.group ?? r.country ?? ri} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cx(onRowClick && 'cursor-pointer', 'hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40', rowClass?.(r))}>
              {columns.map((c, i) => (
                <td key={c.key} className={cx('py-3', i === 0 ? 'pl-5 pr-3' : i === columns.length - 1 ? 'pl-3 pr-5' : 'px-3', c.align === 'right' && 'text-right tabular whitespace-nowrap', hideCls[c.hide], c.className)}>
                  {c.render ? c.render(r, ri) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="border-t border-zinc-300 text-sm font-semibold dark:border-zinc-700">
              {columns.map((c, i) => (
                <td key={c.key} className={cx('py-3', i === 0 ? 'pl-5 pr-3' : i === columns.length - 1 ? 'pl-3 pr-5' : 'px-3', c.align === 'right' && 'text-right tabular whitespace-nowrap', hideCls[c.hide])}>
                  {footer[c.key] ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ---------- Nhỏ: phần trăm, thay đổi, uptime ----------
export const pct = (v, d = 0) => v == null ? '—' : (v * 100).toFixed(d) + '%';

/** Chip thay đổi so với kỳ trước: ▲ 12% / ▼ 5% */
export function Delta({ now, prev, className }) {
  if (!prev || prev <= 0) return null;
  const ch = (now - prev) / prev;
  if (!isFinite(ch)) return null;
  const up = ch >= 0;
  return (
    <span className={cx('inline-flex items-center text-xs font-medium tabular', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400', className)}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {Math.abs(ch * 100).toFixed(ch !== 0 && Math.abs(ch) < 0.1 ? 1 : 0)}%
    </span>
  );
}

export function Uptime({ value }) {
  if (value == null) return <span className="text-zinc-400">—</span>;
  const tone = value >= 0.9 ? 'text-emerald-600 dark:text-emerald-400' : value >= 0.6 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  return <span className={cx('tabular font-medium', tone)}>{pct(value)}</span>;
}

/** Thanh tỷ trọng nhỏ trong bảng */
export function ShareBar({ value }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${Math.min(100, (value || 0) * 100)}%` }} />
      </div>
      <span className="w-10 text-right tabular text-zinc-500">{pct(value)}</span>
    </div>
  );
}

export function SegTabs({ value, onChange, items, size = 'sm' }) {
  return (
    <div className={cx('flex w-fit max-w-full overflow-x-auto rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800', size === 'sm' ? 'text-xs' : 'text-[13px]')}>
      {items.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={cx('whitespace-nowrap rounded-md px-2.5 py-1 font-medium cursor-pointer', value === k ? 'bg-white text-zinc-900 ring-1 ring-zinc-200 dark:bg-zinc-700 dark:text-white dark:ring-zinc-600' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')}>
          {l}
        </button>
      ))}
    </div>
  );
}
