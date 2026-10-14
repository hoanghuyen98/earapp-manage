import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Pencil, Send, Trash2, Info, History, ShieldCheck, AlertTriangle } from 'lucide-react';
import { api, usd, fmtDateTime, timeUntil } from '../lib';
import { Card, CardHeader, Button, Badge, Modal, Field, Input, Select, Tabs, Toggle, SearchInput, Empty, ConfirmButton, PageLoading, useData, useToast, cx } from '../ui';

// Auto-redeem đang cài trên EarnApp của acc (null = chưa cài)
const OWN = '__own__';
const parseRd = a => { try { return a.redeem_details ? JSON.parse(a.redeem_details) : null; } catch { return null; } };

// 0 = Chủ nhật (giống EarnApp / JS)
const WEEKDAYS = [[1, 'T2'], [2, 'T3'], [3, 'T4'], [4, 'T5'], [5, 'T6'], [6, 'T7'], [0, 'CN']];
const dayLabel = d => WEEKDAYS.find(w => w[0] === d)?.[1];
const weekdayOfDate = date => new Date(date + 'T00:00:00Z').getUTCDay();

const RESULT = {
  ok: { label: 'Đã rút', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20' },
  skipped: { label: 'Chưa đủ tiền', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20' },
  retry: { label: 'Đang thử lại', cls: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-500/20' },
  failed: { label: 'Thất bại', cls: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20' },
  missed: { label: 'Lỡ giờ', cls: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700' },
};

function scheduleText(a) {
  if (!a.mode) return null;
  if (a.mode === 'once') {
    const [y, m, d] = a.run_date.split('-');
    return `1 lần: ${a.time} ${dayLabel(weekdayOfDate(a.run_date))} ${d}/${m}/${y}`;
  }
  const days = a.weekdays.split(',').map(Number);
  const sorted = WEEKDAYS.filter(w => days.includes(w[0])).map(w => w[1]);
  return `Hằng tuần: ${a.time} ${sorted.join(', ')}`;
}

function ScheduleForm({ open, onClose, targets, methods, timezone, emails, onSaved }) {
  const toast = useToast();
  const first = targets[0] || {};
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: timezone });
  const [f, setF] = useState(() => ({
    mode: first.mode || 'weekly',
    run_date: first.run_date || tomorrow,
    weekdays: first.weekdays ? first.weekdays.split(',').map(Number) : [],
    time: first.time || '10:00',
    method: first.method || methods[0].id,
    // Mặc định: email đăng ký của từng acc
    email: targets.length === 1 && first.pay_email && first.pay_email !== first.email?.toLowerCase() && emails.includes(first.pay_email) ? first.pay_email : OWN,
  }));
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const meta = methods.find(m => m.id === f.method);
  const toggleDay = d => set('weekdays', f.weekdays.includes(d) ? f.weekdays.filter(x => x !== d) : [...f.weekdays, d]);
  const low = targets.filter(a => a.balance < meta.min);

  const save = async () => {
    setSaving(true);
    try {
      await api('/withdraw', { method: 'PUT', body: { ...f, ids: targets.map(a => a.id), enabled: true, password } });
      toast(targets.length > 1 ? `Đã hẹn giờ rút cho ${targets.length} acc` : 'Đã lưu lịch rút');
      onSaved();
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Hẹn giờ rút tiền"
      subtitle={targets.length > 1 ? `Áp dụng cùng lịch cho ${targets.length} acc đã chọn` : (first.label || first.email)}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Huỷ</Button>
        <Button icon={CalendarClock} loading={saving} disabled={!password} onClick={save}>Lưu lịch</Button>
      </>}>
      <div className="space-y-4">
        <Tabs value={f.mode} onChange={v => set('mode', v)} items={[
          { value: 'once', label: 'Rút 1 lần' },
          { value: 'weekly', label: 'Lặp lại hằng tuần' },
        ]} />
        {f.mode === 'once' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ngày" hint={f.run_date && `Là ${dayLabel(weekdayOfDate(f.run_date))}`}>
              <Input type="date" value={f.run_date} min={new Date().toLocaleDateString('en-CA', { timeZone: timezone })} onChange={e => set('run_date', e.target.value)} />
            </Field>
            <Field label="Giờ"><Input type="time" value={f.time} onChange={e => set('time', e.target.value)} /></Field>
          </div>
        ) : (
          <>
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">Rút vào các thứ</span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map(([d, l]) => (
                  <button key={d} type="button" onClick={() => toggleDay(d)}
                    className={cx('h-9 w-11 rounded-lg text-sm font-medium ring-1 ring-inset transition cursor-pointer',
                      f.weekdays.includes(d) ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800/60 dark:text-zinc-300 dark:ring-zinc-700')}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Giờ"><Input type="time" value={f.time} onChange={e => set('time', e.target.value)} className="max-w-40" /></Field>
          </>
        )}
        <Field label="Nhận tiền qua" hint={`Tối thiểu ${usd(meta.min, 0)}${meta.fee ? ` · ${meta.fee}` : ''}`}>
          <Select value={f.method} onChange={e => set('method', e.target.value)}>
            {methods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label={f.method === 'wise.com' ? 'Email tài khoản Wise' : f.method === 'paypal.com' ? 'Email PayPal' : 'Email nhận Gift Card'}>
          <Select value={f.email} onChange={e => set('email', e.target.value)}>
            <option value={OWN}>{targets.length > 1 ? 'Email đăng ký của từng acc' : `Email đăng ký của acc: ${first.email}`}</option>
            {emails.map(e => <option key={e} value={e}>{e}</option>)}
          </Select>
        </Field>
        {targets.some(parseRd) && (
          <p className="flex gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{targets.length > 1 ? 'Có acc' : 'Acc này'} đang bật Auto-redeem trên EarnApp: EarnApp sẽ tự rút lúc 13:00 mỗi ngày, trước cả giờ hẹn. Vào EarnApp → Cashout → Auto-redeem → Disable để chỉ rút theo lịch này.</span>
          </p>
        )}
        <div className="flex gap-2.5 rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
          <Info className="size-4 shrink-0 text-zinc-400" />
          <div className="space-y-1">
            <p>EarnApp chỉ cho rút <b>toàn bộ số dư</b>. Tới giờ hẹn, web kiểm tra số dư: đủ mức tối thiểu thì rút, chưa đủ thì bỏ qua và báo Telegram.</p>
            <p>Giờ tính theo múi giờ {timezone}. Web phải đang chạy vào giờ hẹn.</p>
            {f.email === OWN && <p>Mỗi acc rút về đúng email đã đăng ký acc đó. Kiểm tra email này có tài khoản {meta.name.split(' ')[0]} chưa, nếu chưa thì tiền sẽ bị treo.</p>}
            <p>Muốn rút về email khác, thêm email đó vào PAYOUT_EMAILS ở file .env trên máy chủ. Mỗi lần lưu lịch đều báo Telegram.</p>
            {low.length > 0 && <p className="text-amber-700 dark:text-amber-400">Hiện {targets.length > 1 ? `${low.length} acc` : 'acc này'} chưa đủ {usd(meta.min, 0)}{targets.length === 1 ? ` (số dư ${usd(first.balance)})` : ''}.</p>}
          </div>
        </div>
        <Field label="Nhập lại mật khẩu web để xác nhận">
          <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e => e.key === 'Enter' && password && save()} />
        </Field>
      </div>
    </Modal>
  );
}

/** Hỏi lại mật khẩu trước thao tác có thể làm tiền đi ra ngoài */
function PasswordPrompt({ ask, onClose }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true);
    try { await ask.onConfirm(password); onClose(); } catch { /* sai mật khẩu: giữ hộp mở để nhập lại */ } finally { setLoading(false); }
  };
  return (
    <Modal open onClose={onClose} title={ask.title}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Huỷ</Button>
        <Button variant={ask.danger ? 'danger' : 'primary'} loading={loading} disabled={!password} onClick={go}>{ask.confirmLabel}</Button>
      </>}>
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">{ask.message}</p>
      <Field label="Mật khẩu web">
        <Input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e => e.key === 'Enter' && password && go()} />
      </Field>
    </Modal>
  );
}

export default function WithdrawSchedule() {
  const toast = useToast();
  const { data, loading, reload } = useData(() => api('/withdraw'), [], 30000);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null); // danh sách acc đang sửa lịch
  const [ask, setAsk] = useState(null);         // hộp hỏi mật khẩu

  const all = useMemo(() => (data?.accounts || []).filter(a => !a.archived_at), [data]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter(a => (tab === 'all' || (tab === 'on' ? a.enabled : !a.enabled))
      && (!s || [a.label, a.email, a.group_name, a.pay_email].some(x => x?.toLowerCase().includes(s))));
  }, [all, tab, q]);

  if (loading && !data) return <PageLoading />;
  const { methods, timezone, log, payout_emails: emails } = data;
  const methodName = id => methods.find(m => m.id === id)?.name || id;
  const on = all.filter(a => a.enabled).length;
  const allSel = list.length > 0 && list.every(a => selected.has(a.id));
  const toggleSel = id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const act = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, 'error'); }
    reload();
  };
  // Lỗi thì báo và ném tiếp để hộp mật khẩu không đóng
  const withPassword = (fn, ok) => async password => {
    try { await fn(password); toast(ok); } catch (e) { toast(e.message, 'error'); throw e; } finally { reload(); }
  };
  const onRd = all.filter(parseRd);

  return (
    <>
      <Card className="mb-4 flex gap-3 p-4 text-[13px] text-zinc-600 dark:text-zinc-400">
        <ShieldCheck className="size-5 shrink-0 text-emerald-600" />
        <div className="space-y-1">
          <p>Mỗi acc chỉ được rút về <b>email đăng ký của chính acc đó</b>{emails.length ? <> hoặc <b>{emails.join(', ')}</b></> : null}. Email khác phải thêm vào PAYOUT_EMAILS trong file .env trên máy chủ.</p>
          <p>Lưu lịch, bật lịch và Rút ngay đều phải nhập lại mật khẩu web và đều được báo Telegram kèm IP. Thông tin nhận tiền trên EarnApp của acc nào bị đổi, web cũng báo ngay.</p>
          {onRd.length > 0 && <p className="text-amber-700 dark:text-amber-400">⚠ {onRd.length} acc đang bật Auto-redeem trên EarnApp: EarnApp tự rút lúc 13:00 mỗi ngày, không theo lịch ở đây.</p>}
        </div>
      </Card>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'all', label: 'Tất cả acc', count: all.length },
          { value: 'on', label: 'Đang hẹn', count: on, dot: 'bg-good' },
          { value: 'off', label: 'Chưa hẹn / tắt', count: all.length - on },
        ]} />
        <div className="flex gap-2">
          {selected.size > 0 && (
            <Button icon={CalendarClock} onClick={() => setEditing(all.filter(a => selected.has(a.id)))}>Hẹn giờ {selected.size} acc</Button>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Tìm acc, email…" className="sm:w-64" />
        </div>
      </div>

      <Card className="mb-6 overflow-hidden">
        {!list.length ? <Empty icon={CalendarClock} title="Không có acc nào" /> : (
          <>
            <label className="flex items-center gap-3 border-b border-zinc-100 px-5 py-2.5 text-xs text-zinc-500 dark:border-zinc-800 cursor-pointer">
              <input type="checkbox" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(list.map(a => a.id)))} className="size-4 accent-indigo-600" />
              Chọn tất cả để hẹn cùng một lịch
            </label>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.map(a => {
                const res = a.last_status && RESULT[a.last_status];
                return (
                  <li key={a.id} className="flex flex-col gap-3 px-5 py-3.5 lg:flex-row lg:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} className="mt-1 size-4 shrink-0 accent-indigo-600 cursor-pointer" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <Link to={`/accounts/${a.id}`} className="truncate font-medium hover:text-indigo-600 hover:underline">{a.label || a.email}</Link>
                          <span className="text-sm tabular text-zinc-500">{usd(a.balance)}</span>
                          {a.status === 'banned' && <Badge className={RESULT.failed.cls}>Bị khoá</Badge>}
                          {parseRd(a) && (
                            <span title="EarnApp tự rút toàn bộ số dư lúc 13:00 mỗi ngày tới email này">
                              <Badge className={[...emails, a.email?.toLowerCase()].includes(parseRd(a).email.toLowerCase()) ? RESULT.skipped.cls : RESULT.failed.cls}>Auto-redeem EarnApp → {parseRd(a).email}</Badge>
                            </span>
                          )}
                        </div>
                        {a.mode ? (
                          <div className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                            <span className={cx('font-medium', a.enabled ? 'text-indigo-600 dark:text-indigo-400' : 'line-through')}>{scheduleText(a)}</span>
                            <span className="text-zinc-400"> · {methodName(a.method)} → {a.pay_email}</span>
                          </div>
                        ) : <div className="mt-0.5 text-[13px] text-zinc-400">Chưa hẹn giờ rút</div>}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                          {a.enabled && a.next_run_at ? <span>Lần tới: <b className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDateTime(a.next_run_at)}</b> ({timeUntil(a.next_run_at)})</span> : null}
                          {res && <span className="inline-flex items-center gap-1.5" title={a.last_message}>
                            <Badge className={res.cls}>{res.label}</Badge>
                            <span className="max-w-96 truncate">{a.last_run_at ? fmtDateTime(a.last_run_at) + ' · ' : ''}{a.last_message}</span>
                          </span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 pl-7 lg:pl-0">
                      {a.mode && (
                        <div className="mr-1" title={a.enabled ? 'Đang bật, bấm để tắt' : 'Đang tắt, bấm để bật'}>
                          <Toggle checked={!!a.enabled} onChange={v => v
                            ? setAsk({ title: 'Bật lại lịch rút?', confirmLabel: 'Bật lịch', message: `${scheduleText(a)} qua ${methodName(a.method)} tới ${a.pay_email}.`,
                              onConfirm: withPassword(password => api(`/withdraw/${a.id}`, { method: 'PATCH', body: { enabled: true, password } }), 'Đã bật lịch rút') })
                            : act(() => api(`/withdraw/${a.id}`, { method: 'PATCH', body: { enabled: false } }), 'Đã tắt lịch rút')} />
                        </div>
                      )}
                      <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing([a])}>{a.mode ? 'Sửa' : 'Hẹn giờ'}</Button>
                      {a.mode && (
                        <Button size="sm" variant="ghost" icon={Send} onClick={() => setAsk({ title: 'Rút ngay bây giờ?', confirmLabel: 'Rút ngay', danger: true,
                          message: `Rút toàn bộ số dư (${usd(a.balance)}) của ${a.label || a.email} qua ${methodName(a.method)} tới ${a.pay_email}. Không huỷ được sau khi gửi.`,
                          onConfirm: withPassword(password => api(`/withdraw/${a.id}/run`, { method: 'POST', body: { password } }), 'Đã gửi lệnh rút') })}>Rút ngay</Button>
                      )}
                      {a.mode && (
                        <ConfirmButton size="icon" variant="ghost" icon={Trash2} title="Xoá lịch rút?" message="Xoá lịch hẹn và thông tin nhận tiền của acc này."
                          onConfirm={() => act(() => api(`/withdraw/${a.id}`, { method: 'DELETE' }), 'Đã xoá lịch')} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <Card>
        <CardHeader icon={History} title="Nhật ký rút tự động" subtitle="100 lần gần nhất, cả rút theo lịch và bấm Rút ngay" />
        {!log.length ? <Empty title="Chưa có lần rút nào" /> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {log.map(l => {
              const res = RESULT[l.status] || RESULT.failed;
              return (
                <li key={l.id} className="flex flex-col gap-1 px-5 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-3">
                  <span className="w-36 shrink-0 text-xs text-zinc-500 tabular">{fmtDateTime(l.ts)}</span>
                  <Badge className={cx(res.cls, 'w-fit')}>{res.label}</Badge>
                  <Link to={`/accounts/${l.account_id}`} className="shrink-0 font-medium hover:text-indigo-600 hover:underline">{l.account}</Link>
                  <span className="min-w-0 text-zinc-500">{l.message}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {editing && (
        <ScheduleForm open targets={editing} methods={methods} timezone={timezone} emails={emails} onClose={() => setEditing(null)}
          onSaved={() => { setSelected(new Set()); reload(); }} />
      )}
      {ask && <PasswordPrompt ask={ask} onClose={() => setAsk(null)} />}
    </>
  );
}
