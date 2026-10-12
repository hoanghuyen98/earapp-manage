import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Download, Clock, CheckCircle2, Receipt } from 'lucide-react';
import { api, usd, vnd, fmtDateTime, txStatus } from '../lib';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Empty, Badge, useData, cx } from '../ui';

const METHOD = { 'paypal.com': 'PayPal', 'amazon.com': 'Amazon Gift Card', wise: 'Wise' };
export const methodName = m => METHOD[m] || m || '—';

export function TxTable({ list, showAccount }) {
  if (!list.length) return <Empty icon={Receipt} title="Chưa có lệnh rút nào" />;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500 dark:border-zinc-800">
              <th className="px-5 py-3 font-medium">Ngày tạo lệnh</th>
              {showAccount && <th className="px-3 py-3 font-medium">Tài khoản</th>}
              <th className="px-3 py-3 font-medium">Phương thức</th>
              <th className="px-3 py-3 font-medium">Trạng thái</th>
              <th className="px-3 py-3 font-medium">Ngày nhận tiền</th>
              <th className="px-3 py-3 text-right font-medium">Phí</th>
              <th className="px-5 py-3 text-right font-medium">Số tiền</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.map(t => {
              const st = txStatus(t.status);
              return (
                <tr key={t.uuid} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                  <td className="px-5 py-3 whitespace-nowrap">{fmtDateTime(t.date)}</td>
                  {showAccount && <td className="max-w-56 truncate px-3 py-3"><Link to={`/accounts/${t.account_id}`} className="hover:text-indigo-600 hover:underline">{t.account}</Link></td>}
                  <td className="px-3 py-3">{methodName(t.payment_method)}</td>
                  <td className="px-3 py-3"><Badge className={st.cls}>{st.label}</Badge></td>
                  <td className="px-3 py-3 text-zinc-500 whitespace-nowrap">{t.payment_date ? fmtDateTime(t.payment_date) : '—'}</td>
                  <td className="px-3 py-3 text-right text-zinc-500 tabular">{t.fee ? usd(t.fee) : '—'}</td>
                  <td className="px-5 py-3 text-right font-semibold tabular">{usd(t.amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
        {list.map(t => {
          const st = txStatus(t.status);
          return (
            <li key={t.uuid} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold tabular">{usd(t.amount)}</span>
                <Badge className={st.cls}>{st.label}</Badge>
              </div>
              <div className="mt-1 flex justify-between gap-2 text-xs text-zinc-500">
                <span className="truncate">{showAccount ? t.account : methodName(t.payment_method)}</span>
                <span className="whitespace-nowrap">{fmtDateTime(t.date)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export default function Payouts() {
  const { data, loading } = useData(() => Promise.all([api('/transactions'), api('/settings')]), [], 60000);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.[0] || []).filter(t => (tab === 'all' || (tab === 'paid' ? t.status === 'paid' : t.status !== 'paid')) &&
      (!s || t.account?.toLowerCase().includes(s)));
  }, [data, tab, q]);

  if (loading && !data) return <PageLoading />;
  const [all, settings] = data;
  const paid = all.filter(t => t.status === 'paid');
  const pending = all.filter(t => t.status !== 'paid');
  const sum = l => l.reduce((s, t) => s + t.amount, 0);
  const fees = sum(paid.map(t => ({ amount: t.fee || 0 })));

  const stats = [
    { label: 'Đã nhận về', value: sum(paid), sub: `${paid.length} lệnh · phí ${usd(fees)}`, icon: CheckCircle2, tone: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-300' },
    { label: 'Đang chờ thanh toán', value: sum(pending), sub: `${pending.length} lệnh`, icon: Clock, tone: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-300' },
    { label: 'Tổng tất cả lệnh rút', value: sum(all), sub: `${all.length} lệnh`, icon: Wallet, tone: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-500/10 dark:text-indigo-300' },
  ];

  return (
    <>
      <PageHeader title="Rút tiền" subtitle="Lịch sử rút và các lệnh rút đang chờ của tất cả tài khoản">
        <a href="/api/export/transactions"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
      </PageHeader>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {stats.map(s => (
          <Card key={s.label} className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-zinc-500">{s.label}</span>
              <span className={cx('rounded-lg p-1.5', s.tone)}><s.icon className="size-4" /></span>
            </div>
            <div className="mt-2 text-2xl font-semibold tabular">{usd(s.value)}</div>
            <div className="mt-1 text-xs text-zinc-500 tabular">≈ {vnd(s.value * settings.usd_vnd)} · {s.sub}</div>
          </Card>
        ))}
      </div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'all', label: 'Tất cả', count: all.length },
          { value: 'pending', label: 'Đang chờ', count: pending.length, dot: 'bg-warn' },
          { value: 'paid', label: 'Đã nhận', count: paid.length, dot: 'bg-good' },
        ]} />
        <SearchInput value={q} onChange={setQ} placeholder="Tìm theo tài khoản…" className="sm:w-72" />
      </div>
      <Card className="overflow-hidden"><TxTable list={list} showAccount /></Card>
    </>
  );
}
