import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Pencil, Send, Trash2, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { api, usd, fmtDateTime, timeUntil } from '../lib';
import { Card, CardHeader, Button, Badge, Modal, Field, Input, Select, Tabs, Toggle, SearchInput, Empty, ConfirmButton, PageLoading, GroupTag, TimePicker, DatePicker, byAccount, useData, useToast, cx } from '../ui';

// Auto-redeem đang cài trên EarnApp của acc (null = chưa cài)
const OWN = '__own__';
const parseRd = a => { try { return a.redeem_details ? JSON.parse(a.redeem_details) : null; } catch { return null; } };

// Tên múi giờ dễ đọc
const tzName = tz => tz === 'Asia/Ho_Chi_Minh' || tz === 'Asia/Saigon' ? 'giờ Việt Nam' : tz;
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

/** Trạng thái đang rút của 1 acc: từ máy chủ, hoặc lịch đã tới giờ mà máy chủ chưa kịp chạy (kiểm tra mỗi 30 giây) */
function liveState(a, progress, now) {
  const p = progress?.[a.id];
  if (p) return p;
  if (a.enabled && a.next_run_at && a.next_run_at <= now && a.last_status !== 'retry') return { state: 'due', step: 'Tới giờ, sắp rút', since: a.next_run_at };
  return null;
}
const secsSince = (ts, now) => Math.max(0, Math.round((now - ts) / 1000));

/** "Đang rút…" kèm việc đang làm và đã chạy bao lâu */
function LiveBadge({ p, now }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20">
      <Loader2 className="size-3.5 animate-spin" />
      {p.state === 'running' ? <>Đang rút <span className="font-normal opacity-80">· {p.step}…</span></> : `${p.step}…`}
      {p.since ? <span className="font-normal tabular opacity-60">{secsSince(p.since, now)}s</span> : null}
    </span>
  );
}

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
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
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
      subtitle={targets.length > 1 ? `${targets.length} acc` : (first.label ? `${first.label} · ${first.email}` : first.email)}
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
              <DatePicker value={f.run_date} min={todayIso} today={todayIso} onChange={v => set('run_date', v)} />
            </Field>
            <Field label={`Giờ (${tzName(timezone)})`}><TimePicker value={f.time} onChange={v => set('time', v)} /></Field>
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
            <Field label={`Giờ (${tzName(timezone)})`}><TimePicker value={f.time} onChange={v => set('time', v)} className="max-w-40" /></Field>
          </>
        )}
        <Field label="Nhận tiền qua" hint={`Tối thiểu ${usd(meta.min, 0)}${meta.fee ? ` · ${meta.fee}` : ''}`}>
          <Select value={f.method} onChange={e => set('method', e.target.value)}>
            {methods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label={f.method === 'wise.com' ? 'Email tài khoản Wise' : f.method === 'paypal.com' ? 'Email PayPal' : 'Email nhận Gift Card'}>
          <Select value={f.email} onChange={e => set('email', e.target.value)}>
            <option value={OWN}>{targets.length > 1 ? 'Email của từng acc' : first.email}</option>
            {emails.map(e => <option key={e} value={e}>{e}</option>)}
          </Select>
        </Field>
        {targets.some(parseRd) && (
          <p className="flex gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{targets.length > 1 ? 'Có acc' : 'Acc này'} bật Auto-redeem: EarnApp tự rút lúc 13:00. Tắt ở EarnApp → Cashout → Auto-redeem.</span>
          </p>
        )}
        <div className="space-y-1 rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
          <p>Tới giờ: đủ {usd(meta.min, 0)} thì rút toàn bộ số dư, chưa đủ thì bỏ qua. Giờ theo {tzName(timezone)}, 24 giờ.</p>
          <p>Email nhận phải có tài khoản {meta.name.split(' ')[0]}, nếu không tiền sẽ bị treo.</p>
          {low.length > 0 && <p className="text-amber-700 dark:text-amber-400">{targets.length > 1 ? `${low.length} acc` : 'Acc này'} hiện chưa đủ {usd(meta.min, 0)}.</p>}
        </div>
        <Field label="Mật khẩu web">
          <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e => e.key === 'Enter' && password && save()} />
        </Field>
      </div>
    </Modal>
  );
}

/** Rút ngay toàn bộ số dư của 1 hoặc nhiều acc, không cần hẹn lịch */
function WithdrawNowForm({ targets, methods, emails, onClose, onDone }) {
  const toast = useToast();
  const first = targets[0];
  const [method, setMethod] = useState(targets.length === 1 && first.method ? first.method : methods[0].id);
  const [email, setEmail] = useState(targets.length === 1 && first.pay_email && emails.includes(first.pay_email) ? first.pay_email : OWN);
  const [password, setPassword] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null); // [{ a, ok, message }]
  const meta = methods.find(m => m.id === method);
  const ready = targets.filter(a => a.balance >= meta.min && a.status !== 'banned');
  const total = ready.reduce((n, a) => n + (a.balance || 0), 0);

  const go = async () => {
    setRunning(true);
    setResults([]); // hiện ngay dòng "Đang rút…" thay vì chỉ quay vòng ở nút
    const out = [];
    try {
      // Chỉ gửi acc đủ tiền (máy chủ vẫn kiểm tra lại số dư thật trước khi rút)
      for (const a of ready) {
        try {
          const r = await api(`/withdraw/${a.id}/run`, { method: 'POST', body: { method, email, password } });
          out.push({ a, ok: true, message: r.message });
        } catch (e) {
          // Sai mật khẩu / bị chặn: dừng luôn, giữ hộp mở để nhập lại
          if (e.status === 403 || e.status === 429) { if (!out.length) throw e; out.push({ a, ok: false, message: e.message }); break; }
          out.push({ a, ok: false, message: e.message });
        }
        setResults([...out]);
      }
      setResults(out);
      onDone();
    } catch (e) {
      setResults(null);
      toast(e.message, 'error');
    } finally {
      setRunning(false);
    }
  };
  const done = results && !running;
  // Acc đang rút + việc máy chủ đang làm (hỏi mỗi giây)
  const cur = running ? ready[(results || []).length] : null;
  const [step, setStep] = useState('');
  useEffect(() => {
    if (!cur) { setStep(''); return; }
    let stop = false;
    const poll = async () => {
      try { const r = await api('/withdraw'); if (!stop) setStep(r.progress?.[cur.id]?.step || ''); } catch { /* thử lại lần sau */ }
      if (!stop) setTimeout(poll, 1000);
    };
    poll();
    return () => { stop = true; };
  }, [cur?.id]); // eslint-disable-line

  return (
    <Modal open onClose={running ? () => {} : onClose} title={targets.length > 1 ? `Rút ngay ${targets.length} acc` : 'Rút ngay'}
      subtitle={targets.length > 1 ? `${targets.length} acc` : (first.label ? `${first.label} · ${first.email}` : first.email)}
      footer={done ? <Button onClick={onClose}>Đóng</Button> : <>
        <Button variant="secondary" disabled={running} onClick={onClose}>Huỷ</Button>
        <Button variant="danger" icon={Send} loading={running} disabled={!password || !ready.length} onClick={go}>
          Rút {usd(total)}{ready.length > 1 ? ` (${ready.length} acc)` : ''}
        </Button>
      </>}>
      {results ? (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {results.map(({ a, ok, message }) => (
            <li key={a.id} className="flex flex-col gap-0.5 py-2">
              <span className="flex items-center gap-2"><Badge className={(ok ? RESULT.ok : RESULT.failed).cls}>{ok ? 'Đã rút' : 'Không rút'}</Badge><b className="truncate font-medium">{a.label ? `${a.label} · ${a.email}` : a.email}</b></span>
              <span className="text-xs text-zinc-500">{message}</span>
            </li>
          ))}
          {running && <li className="flex items-center gap-2 py-2 text-xs text-zinc-500"><Loader2 className="size-3.5 animate-spin text-indigo-500" />Đang rút {results.length + 1}/{ready.length}: <b className="font-medium">{cur?.label || cur?.email}</b> · {step || 'Đang chờ lượt'}…</li>}
        </ul>
      ) : (
        <div className="space-y-4">
          <Field label="Nhận tiền qua" hint={`Tối thiểu ${usd(meta.min, 0)}${meta.fee ? ` · ${meta.fee}` : ''}`}>
            <Select value={method} onChange={e => setMethod(e.target.value)}>
              {methods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label={method === 'wise.com' ? 'Email tài khoản Wise' : method === 'paypal.com' ? 'Email PayPal' : 'Email nhận Gift Card'}>
            <Select value={email} onChange={e => setEmail(e.target.value)}>
              <option value={OWN}>{targets.length > 1 ? 'Email của từng acc' : first.email}</option>
              {emails.map(e => <option key={e} value={e}>{e}</option>)}
            </Select>
          </Field>
          <div className="space-y-1 rounded-xl bg-red-50 p-3 text-xs text-red-800 dark:bg-red-500/10 dark:text-red-300">
            <p>Rút <b>toàn bộ số dư</b>, không huỷ được. Email nhận phải có tài khoản {meta.name.split(' ')[0]}.</p>
            {targets.length - ready.length > 0 && <p>{targets.length > 1 ? `${targets.length - ready.length} acc` : 'Acc này'} chưa đủ {usd(meta.min, 0)} hoặc bị khoá, sẽ bỏ qua.</p>}
          </div>
          <Field label="Mật khẩu web">
            <Input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e => e.key === 'Enter' && password && ready.length && go()} />
          </Field>
        </div>
      )}
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
  // Đồng hồ máy chủ (tránh lệch giờ máy người xem) + đếm giây cho trạng thái đang rút
  const [tick, setTick] = useState(0);
  const now = data ? data.now + tick : Date.now();
  useEffect(() => { setTick(0); const t0 = Date.now(); const t = setInterval(() => setTick(Date.now() - t0), 1000); return () => clearInterval(t); }, [data]);
  const busy = !!data && (data.accounts || []).some(a => liveState(a, data.progress, now) || (a.enabled && a.next_run_at && a.next_run_at - now < 60e3));
  // Đang rút / sắp tới giờ: cập nhật mỗi 2 giây thay vì 30 giây
  useEffect(() => { if (!busy) return; const t = setInterval(reload, 2000); return () => clearInterval(t); }, [busy, reload]);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null); // danh sách acc đang sửa lịch
  const [ask, setAsk] = useState(null);         // hộp hỏi mật khẩu
  const [withdrawing, setWithdrawing] = useState(null); // danh sách acc đang mở hộp Rút ngay

  const all = useMemo(() => (data?.accounts || []).filter(a => !a.archived_at).sort(byAccount), [data]);
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
  const live = all.map(a => [a, liveState(a, data.progress, now)]).filter(([, p]) => p);

  return (
    <>
      <div className="mb-4 space-y-1 text-[13px] text-zinc-500">
        <p className="flex items-center gap-2"><ShieldCheck className="size-4 shrink-0 text-good" />Chỉ rút về email đăng ký của acc{emails.length ? <> hoặc {emails.join(', ')}</> : null}. Mọi thao tác cần mật khẩu và báo Telegram.</p>
        {onRd.length > 0 && <p className="flex items-center gap-2 text-amber-700 dark:text-amber-400"><AlertTriangle className="size-4 shrink-0" />{onRd.length} acc bật Auto-redeem: EarnApp tự rút lúc 13:00 hằng ngày.</p>}
      </div>

      {live.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-indigo-50 px-4 py-3 text-sm text-indigo-900 ring-1 ring-inset ring-indigo-600/15 dark:bg-indigo-500/10 dark:text-indigo-200 dark:ring-indigo-400/20">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
          <div className="min-w-0">
            <p className="font-medium">Đang rút tiền cho {live.length} acc. Web tự chạy, không cần giữ trang này mở.</p>
            <ul className="mt-1 space-y-0.5 text-[13px] opacity-90">
              {live.map(([a, p]) => <li key={a.id} className="truncate"><b className="font-medium">{a.label || a.email}</b> · {usd(a.balance)} · {p.step}…</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'all', label: 'Tất cả', count: all.length },
          { value: 'on', label: 'Đang hẹn', count: on, dot: 'bg-good' },
          { value: 'off', label: 'Chưa hẹn', count: all.length - on },
        ]} />
        <div className="flex gap-2">
          {selected.size > 0 && (
            <>
              <Button variant="danger" icon={Send} onClick={() => setWithdrawing(all.filter(a => selected.has(a.id)))}>Rút ngay {selected.size} acc</Button>
              <Button icon={CalendarClock} onClick={() => setEditing(all.filter(a => selected.has(a.id)))}>Hẹn giờ {selected.size} acc</Button>
            </>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Tìm acc, email…" className="sm:w-64" />
        </div>
      </div>

      <Card className="mb-6 overflow-hidden">
        {!list.length ? <Empty icon={CalendarClock} title="Không có acc nào" /> : (
          <>
            <label className="flex items-center gap-3 border-b border-zinc-100 px-5 py-2.5 text-xs text-zinc-500 dark:border-zinc-800 cursor-pointer">
              <input type="checkbox" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(list.map(a => a.id)))} className="size-4 accent-indigo-600" />
              Chọn tất cả
            </label>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.map(a => {
                const res = a.last_status && RESULT[a.last_status];
                const p = liveState(a, data.progress, now);
                return (
                  <li key={a.id} className="flex flex-col gap-3 px-5 py-3.5 lg:flex-row lg:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} className="mt-1 size-4 shrink-0 accent-indigo-600 cursor-pointer" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <Link to={`/accounts/${a.id}`} className="truncate font-medium hover:text-indigo-600 hover:underline">{a.label || a.email}</Link>
                          <GroupTag name={a.group_name} />
                          {a.label && <span className="truncate text-xs text-zinc-500">{a.email}</span>}
                          <span className="text-sm font-medium tabular">{usd(a.balance)}</span>
                          {a.status === 'banned' && <Badge className={RESULT.failed.cls}>Bị khoá</Badge>}
                          {parseRd(a) && (
                            <span title="EarnApp tự rút toàn bộ số dư lúc 13:00 mỗi ngày tới email này">
                              <Badge className={[...emails, a.email?.toLowerCase()].includes(parseRd(a).email.toLowerCase()) ? RESULT.skipped.cls : RESULT.failed.cls}>Auto-redeem → {parseRd(a).email}</Badge>
                            </span>
                          )}
                        </div>
                        {a.mode ? (
                          <div className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                            <span className={cx('font-medium', a.enabled ? 'text-indigo-600 dark:text-indigo-400' : 'line-through')}>{scheduleText(a)}</span>
                            <span className="text-zinc-400"> · {methodName(a.method)} → {a.pay_email}</span>
                          </div>
                        ) : <div className="mt-0.5 text-[13px] text-zinc-400">Chưa hẹn</div>}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                          {p ? <LiveBadge p={p} now={now} />
                            : a.enabled && a.next_run_at ? <span>Lần tới: <b className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDateTime(a.next_run_at)}</b> ({timeUntil(a.next_run_at)})</span> : null}
                          {res && !p && <span className="inline-flex items-center gap-1.5" title={a.last_message}>
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
                      <Button size="sm" variant="ghost" icon={Send} onClick={() => setWithdrawing([a])}>Rút ngay</Button>
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
        <CardHeader title="Nhật ký rút" />
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
      {withdrawing && (
        <WithdrawNowForm targets={withdrawing} methods={methods} emails={emails} onClose={() => setWithdrawing(null)}
          onDone={() => { setSelected(new Set()); reload(); }} />
      )}
      {ask && <PasswordPrompt ask={ask} onClose={() => setAsk(null)} />}
    </>
  );
}
