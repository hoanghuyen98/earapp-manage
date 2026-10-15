import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Receipt } from 'lucide-react';
import { api, usd, vnd, fmtDateTime, txStatus } from '../lib';
import WithdrawSchedule from './WithdrawSchedule';
import { Card, Button, PageHeader, PageLoading, Tabs, SearchInput, Empty, StateText, AccName, byAccount, useData } from '../ui';
import { StatStrip } from './Dashboard';

const txDot = s => s === 'paid' ? 'bg-good' : 'bg-warn';

const METHOD = { 'paypal.com': 'PayPal', 'amazon.com': 'Amazon Gift Card', wise: 'Wise', 'wise.com': 'Wise' };
export const methodName = m => METHOD[m] || (/^amazon/.test(m || '') ? 'Amazon Gift Card' : m || '—');

export function TxTable({ list, showAccount }) {
  if (!list.length) return <Empty icon={Receipt} title="Chưa có lệnh rút nào" />;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="px-5 py-3 font-medium">Ngày tạo lệnh</th>
              {showAccount && <th className="px-3 py-3 font-medium">Tài khoản</th>}
              <th className="px-3 py-3 font-medium">Phương thức</th>
              <th className="px-3 py-3 font-medium">Trạng thái</th>
              <th className="px-3 py-3 font-medium">Ngày nhận</th>
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
                  {showAccount && <td className="max-w-60 px-3 py-3"><Link to={`/accounts/${t.account_id}`} className="block hover:text-indigo-600"><AccName small label={t.label} email={t.email} group={t.group_name} /></Link></td>}
                  <td className="px-3 py-3">{methodName(t.payment_method)}</td>
                  <td className="px-3 py-3"><StateText dot={txDot(t.status)} label={st.label} /></td>
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
                <StateText dot={txDot(t.status)} label={st.label} />
              </div>
              <div className="mt-1 flex justify-between gap-2 text-xs text-zinc-500">
                <span className="truncate">{showAccount ? t.label || t.email : methodName(t.payment_method)}</span>
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
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'schedule' ? 'schedule' : 'history';
  const viewTabs = (
    <Tabs value={view} onChange={v => setParams(v === 'schedule' ? { view: v } : {}, { replace: true })} items={[
      { value: 'history', label: 'Lịch sử' },
      { value: 'schedule', label: 'Rút & hẹn giờ' },
    ]} />
  );
  if (view === 'schedule') {
    return (
      <>
        <PageHeader title="Rút tiền">{viewTabs}</PageHeader>
        <WithdrawSchedule />
      </>
    );
  }
  return <PayoutHistory viewTabs={viewTabs} />;
}

function PayoutHistory({ viewTabs }) {
  const { data, loading } = useData(() => Promise.all([api('/transactions'), api('/settings')]), [], 60000);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.[0] || []).filter(t => (tab === 'all' || (tab === 'paid' ? t.status === 'paid' : t.status !== 'paid')) &&
      (!s || [t.label, t.email, t.group_name].some(x => x?.toLowerCase().includes(s))))
      .sort((x, y) => String(y.date).localeCompare(String(x.date)) || byAccount(x, y));
  }, [data, tab, q]);

  if (loading && !data) return <PageLoading />;
  const [all, settings] = data;
  const paid = all.filter(t => t.status === 'paid');
  const pending = all.filter(t => t.status !== 'paid');
  const sum = l => l.reduce((s, t) => s + t.amount, 0);
  const fees = sum(paid.map(t => ({ amount: t.fee || 0 })));

  const stats = [
    { label: 'Đã nhận về', value: sum(paid), sub: `${paid.length} lệnh · phí ${usd(fees)}` },
    { label: 'Đang chờ', value: sum(pending), sub: `${pending.length} lệnh` },
    { label: 'Tổng các lệnh', value: sum(all), sub: `${all.length} lệnh` },
  ];

  return (
    <>
      <PageHeader title="Rút tiền">
        {viewTabs}
        <a href="/api/export/transactions"><Button variant="secondary" icon={Download}>Xuất Excel</Button></a>
      </PageHeader>
      <StatStrip className="mb-6" items={stats.map(x => ({ label: x.label, big: true, value: usd(x.value), sub: x.sub, title: `≈ ${vnd(x.value * settings.usd_vnd)}` }))} />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'all', label: 'Tất cả', count: all.length },
          { value: 'pending', label: 'Đang chờ', count: pending.length, dot: 'bg-warn' },
          { value: 'paid', label: 'Đã nhận', count: paid.length, dot: 'bg-good' },
        ]} />
        <SearchInput value={q} onChange={setQ} placeholder="Tìm tên, email, máy…" className="sm:w-72" />
      </div>
      <Card className="overflow-hidden"><TxTable list={list} showAccount /></Card>
    </>
  );
}
