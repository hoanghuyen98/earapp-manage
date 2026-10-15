import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import { usd, vnd, vndShort, shortDate, fmtBytes } from './lib';

function ChartTip({ active, payload, rate, render }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl bg-white px-3 py-2 text-[13px] shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
      {render ? render(p) : (
        <>
          <div className="text-zinc-500 dark:text-zinc-400">{p.date.split('-').reverse().join('/')}</div>
          <div className="mt-0.5 font-semibold tabular">{usd(p.value, 3)}</div>
          {rate && <div className="text-xs text-zinc-500 tabular">≈ {vnd(p.value * rate)}</div>}
        </>
      )}
    </div>
  );
}

const axis = { fontSize: 11, fill: 'var(--chart-text)' };
const grid = <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4" />;
const cursor = { fill: 'var(--chart-cursor)', radius: 4 };

/** Màu cột chuyển nhẹ từ sáng (trên) xuống đậm (dưới) */
const Gradient = ({ id, top, bottom }) => (
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={top} />
      <stop offset="100%" stopColor={bottom} />
    </linearGradient>
  </defs>
);

export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
export const seriesColor = (key, i) => key === 'other' ? 'var(--s-other)' : SERIES_COLORS[i % SERIES_COLORS.length];

export function SeriesLegend({ series }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-600 dark:text-zinc-300">
      {series.map((s, i) => (
        <span key={s.key} className="inline-flex max-w-48 items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(s.key, i) }} />
          <span className="truncate">{s.name}</span>
        </span>
      ))}
    </div>
  );
}

/** Thu nhập theo ngày tách theo tài khoản (cột chồng, tối đa 5 acc + "Các acc khác") */
export function StackedDaily({ data, series, rate, height = 240 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barCategoryGap="22%">
        {grid}
        <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tickFormatter={v => '$' + v} tick={axis} tickLine={false} axisLine={false} width={52} />
        <Tooltip cursor={cursor} content={<ChartTip render={p => (
          <>
            <div className="text-zinc-500 dark:text-zinc-400">{p.date.split('-').reverse().join('/')}</div>
            <div className="mt-1 space-y-0.5">
              {series.map((s, i) => p[s.key] ? (
                <div key={s.key} className="flex items-center justify-between gap-4">
                  <span className="inline-flex max-w-40 items-center gap-1.5"><span className="size-2 shrink-0 rounded-sm" style={{ background: seriesColor(s.key, i) }} /><span className="truncate">{s.name}</span></span>
                  <span className="tabular">{usd(p[s.key], 3)}</span>
                </div>
              ) : null)}
            </div>
            <div className="mt-1 flex justify-between gap-4 border-t border-zinc-100 pt-1 font-semibold dark:border-zinc-700"><span>Tổng</span><span className="tabular">{usd(p.value, 3)}</span></div>
            {rate && <div className="text-right text-xs text-zinc-500 tabular">≈ {vnd(p.value * rate)}</div>}
          </>
        )} />} />
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} stackId="a" fill={seriesColor(s.key, i)} stroke="var(--chart-surface)" strokeWidth={1}
            radius={i === series.length - 1 ? [5, 5, 0, 0] : 0} maxBarSize={26} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Chia trục thành 4 khoảng tròn (1, 2, 2.5, 5 × 10^n) */
function niceTicks(max) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(v => v >= raw);
  return [0, 1, 2, 3, 4].map(i => i * step);
}

/** Cột dung lượng theo ngày hoặc theo tháng (byte) */
export function UsageBars({ data, height = 240, xKey = 'date' }) {
  const ticks = niceTicks(Math.max(1e8, ...data.map(d => d.value || 0)));
  const last = data[data.length - 1]?.[xKey];
  const label = v => xKey === 'month' ? 'T' + Number(v.slice(5)) + '/' + v.slice(2, 4) : shortDate(v);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%">
        {grid}
        <XAxis dataKey={xKey} tickFormatter={label} tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tickFormatter={v => v ? fmtBytes(v, true) : '0'} domain={[0, ticks[4]]} ticks={ticks} tick={axis} tickLine={false} axisLine={false} width={58} />
        <Tooltip cursor={cursor} content={<ChartTip render={p => (
          <>
            <div className="text-zinc-500 dark:text-zinc-400">{xKey === 'month' ? `Tháng ${Number(p.month.slice(5))}/${p.month.slice(0, 4)}` : p.date.split('-').reverse().join('/')}</div>
            <div className="mt-0.5 font-semibold tabular">{fmtBytes(p.value)}</div>
          </>
        )} />} />
        <Gradient id="g-usage" top="var(--chart-3-top)" bottom="var(--chart-3)" />
        <Bar dataKey="value" radius={[5, 5, 1, 1]} maxBarSize={xKey === 'month' ? 40 : 26} isAnimationActive={false}>
          {data.map(d => <Cell key={d[xKey]} fill="url(#g-usage)" fillOpacity={d[xKey] === last ? 0.45 : 1} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Cột thu nhập theo ngày (1 chuỗi, màu chart-1) */
export function DailyBars({ data, rate, height = 240 }) {
  const today = data[data.length - 1]?.date;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barCategoryGap="22%">
        {grid}
        <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tickFormatter={v => '$' + v} tick={axis} tickLine={false} axisLine={false} width={52} allowDecimals />
        <Tooltip content={<ChartTip rate={rate} />} cursor={cursor} />
        <Gradient id="g-earn" top="var(--chart-1-top)" bottom="var(--chart-1)" />
        <Bar dataKey="value" radius={[5, 5, 1, 1]} maxBarSize={26} isAnimationActive={false}>
          {data.map(d => <Cell key={d.date} fill="url(#g-earn)" fillOpacity={d.date === today ? 0.45 : 1} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Lãi lỗ theo tháng: cột dương/âm quanh mốc 0 */
export function ProfitBars({ data, height = 260 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="30%">
        {grid}
        <XAxis dataKey="month" tickFormatter={m => 'T' + Number(m.slice(5)) + '/' + m.slice(2, 4)} tick={axis} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={vndShort} tick={axis} tickLine={false} axisLine={false} width={52} />
        <ReferenceLine y={0} stroke="var(--chart-text)" strokeOpacity={0.4} />
        <Tooltip cursor={cursor} content={<ChartTip render={p => (
          <>
            <div className="text-zinc-500 dark:text-zinc-400">Tháng {Number(p.month.slice(5))}/{p.month.slice(0, 4)}</div>
            <div className="mt-1 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular">
              <span className="text-zinc-500">Thu</span><span className="text-right">{vnd(p.income_vnd)}</span>
              <span className="text-zinc-500">Chi</span><span className="text-right">{vnd(p.cost_vnd)}</span>
              <span className="font-medium">Lãi</span><span className="text-right font-semibold">{vnd(p.profit_vnd)}</span>
            </div>
          </>
        )} />} />
        <Gradient id="g-profit" top="var(--chart-1-top)" bottom="var(--chart-1)" />
        <Bar dataKey="profit_vnd" radius={5} maxBarSize={40} isAnimationActive={false}>
          {data.map(d => <Cell key={d.month} fill={d.profit_vnd >= 0 ? 'url(#g-profit)' : 'var(--chart-2)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
