import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, CheckCircle2, AlertCircle, Search, TriangleAlert, Clock, ChevronDown, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { DEVICE_STATUS, ACCOUNT_STATUS } from './lib';

export const cx = (...a) => a.filter(Boolean).join(' ');

export function Card({ className, children, ...p }) {
  return (
    <div className={cx('rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', className)} {...p}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold uppercase tracking-[.06em] text-zinc-500 dark:text-zinc-400">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-zinc-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const BTN = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-200 dark:text-indigo-950 dark:hover:bg-indigo-100',
  secondary: 'bg-white text-zinc-700 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-700/70',
  ghost: 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
  danger: 'bg-bad text-white hover:bg-red-800',
};

export function Button({ variant = 'primary', size = 'md', loading, icon: Icon, className, children, ...p }) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer whitespace-nowrap',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'icon' ? 'size-9' : 'h-9 px-4 text-sm',
        BTN[variant], className,
      )}
      disabled={loading || p.disabled}
      {...p}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon && <Icon className="size-4" />}
      {children}
    </button>
  );
}

export const inputCls = 'w-full rounded-xl border-0 bg-white px-3 py-2 text-sm ring-1 ring-inset ring-zinc-300/80 placeholder:text-zinc-400 focus:ring-2 focus:ring-indigo-600 focus:outline-none dark:bg-zinc-800/60 dark:ring-zinc-700 dark:focus:ring-indigo-400';

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const Input = (p) => <input {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p) => <textarea {...p} className={cx(inputCls, 'min-h-24', p.className)} />;
// ---------- Chọn giờ kiểu 24h ----------
const pad2 = n => String(n).padStart(2, '0');
/** "2345" / "23:45" / "9h30" / "9" -> "23:45" / "09:30" / "09:00"; sai -> null */
export function parseTime(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?:\s*[:hH.]\s*|\s+)?(\d{2})?$/) || String(s).trim().match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? `${pad2(h)}:${pad2(mi)}` : null;
}

function TimeColumn({ label, count, value, onPick }) {
  const box = useRef(null);
  // Mở ra thì cuộn tới số đang chọn (cuộn trong cột, không cuộn cả trang)
  useLayoutEffect(() => {
    const el = box.current?.querySelector('[data-on="1"]');
    if (el) box.current.scrollTop = el.offsetTop - box.current.clientHeight / 2 + el.clientHeight / 2;
  }, []);
  return (
    <div className="flex-1">
      <div className="pb-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</div>
      <div ref={box} className="relative h-52 overflow-y-auto overscroll-contain px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent,#000_8px,#000_calc(100%-8px),transparent)]">
        {Array.from({ length: count }, (_, i) => {
          const on = i === value;
          return (
            <button key={i} type="button" data-on={on ? 1 : 0} onClick={() => onPick(i)}
              className={cx('mb-0.5 block h-8 w-full rounded-lg text-sm tabular transition-colors cursor-pointer',
                on ? 'bg-indigo-600 font-semibold text-white' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')}>
              {pad2(i)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Bảng nổi gắn dưới (hoặc trên) 1 ô nhập: tự đặt vị trí, bấm ra ngoài / Esc để đóng (Esc không đóng cả cửa sổ) */
function usePopover(minWidth, height) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchor = useRef(null), panel = useRef(null);
  const place = () => {
    if (!anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const w = Math.max(minWidth, r.width), gap = 6;
    const below = window.innerHeight - r.bottom > height + gap || r.top < height + gap;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), width: w,
      ...(below ? { top: r.bottom + gap } : { bottom: window.innerHeight - r.top + gap }) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line
  useEffect(() => {
    if (!open) return;
    const away = e => !anchor.current?.contains(e.target) && !panel.current?.contains(e.target) && setOpen(false);
    const esc = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); } };
    const move = e => !panel.current?.contains(e.target) && place();
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', move, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', move, true);
    };
  }, [open]); // eslint-disable-line
  const render = children => open && pos && createPortal(
    <div ref={panel} style={{ position: 'fixed', ...pos }}
      className="z-[60] rounded-2xl bg-white p-2 shadow-xl ring-1 ring-zinc-900/10 animate-fade-in dark:bg-zinc-900 dark:ring-zinc-700">
      {children}
    </div>, document.body);
  return { open, setOpen, anchor, render };
}

/** Khung ô nhập có biểu tượng bên trái + nút mở bảng bên phải */
function PickerField({ pop, icon: Icon, label, className, ...input }) {
  return (
    <div ref={pop.anchor} className={cx('relative', className)}>
      <div className={cx(inputCls.replace('py-2', ''), 'flex items-center gap-2 pr-1.5', pop.open && 'ring-2 ring-indigo-600 dark:ring-indigo-400')}>
        <Icon className="size-4 shrink-0 text-zinc-400" />
        <input {...input} aria-label={label} onFocus={() => pop.setOpen(true)}
          className="w-full min-w-0 bg-transparent py-2 text-sm font-medium tabular tracking-wide focus:outline-none" />
        <button type="button" tabIndex={-1} aria-label={`Chọn ${label.toLowerCase()}`} onClick={() => pop.setOpen(o => !o)}
          className="-my-1 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 cursor-pointer">
          <ChevronDown className={cx('size-4 transition-transform', pop.open && 'rotate-180')} />
        </button>
      </div>
    </div>
  );
}

export function TimePicker({ value = '10:00', onChange, className }) {
  const pop = usePopover(232, 300);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const [h, m] = value.split(':').map(Number);
  const commit = () => { const t = parseTime(text); t ? onChange(t) : setText(value); };
  return (
    <>
      <PickerField pop={pop} icon={Clock} label="Giờ" className={className} value={text} inputMode="numeric" maxLength={5} placeholder="HH:MM"
        onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); pop.setOpen(false); } }} />
      {pop.render(<>
        <div className="flex gap-1">
          <TimeColumn label="Giờ" count={24} value={h} onPick={i => onChange(`${pad2(i)}:${pad2(m)}`)} />
          <div className="w-px self-stretch bg-zinc-100 dark:bg-zinc-800" />
          <TimeColumn label="Phút" count={60} value={m} onPick={i => onChange(`${pad2(h)}:${pad2(i)}`)} />
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-zinc-100 px-1 pt-2 dark:border-zinc-800">
          <span className="text-lg font-semibold tabular">{value}</span>
          <Button size="sm" onClick={() => pop.setOpen(false)}>Xong</Button>
        </div>
      </>)}
    </>
  );
}

// ---------- Chọn ngày kiểu ngày/tháng/năm ----------
const isoToVn = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
const isoOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`; // m: 0–11
/** "16/10/2026" / "16-10-2026" / "16.10.26" / "16102026" / "16/10" (năm nay) -> "2026-10-16"; sai -> null */
export function parseDate(s, thisYear = new Date().getFullYear()) {
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})[/.\-\s](\d{1,2})(?:[/.\-\s](\d{2}|\d{4}))?$/) || t.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]) - 1;
  let y = m[3] ? Number(m[3]) : thisYear;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? isoOf(y, mo, d) : null;
}
const VN_DOW = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

/** value, min, today: "YYYY-MM-DD" (today theo múi giờ của web, để đánh dấu "hôm nay") */
export function DatePicker({ value, onChange, min, today, className }) {
  const pop = usePopover(284, 360);
  const [text, setText] = useState(isoToVn(value));
  const [view, setView] = useState(() => (value || today || '').slice(0, 7)); // "YYYY-MM" đang xem
  useEffect(() => setText(isoToVn(value)), [value]);
  useEffect(() => { if (pop.open) setView((value || today || '').slice(0, 7)); }, [pop.open]); // eslint-disable-line

  const ok = iso => !!iso && (!min || iso >= min);
  const commit = () => { const iso = parseDate(text); ok(iso) ? onChange(iso) : setText(isoToVn(value)); };
  const pick = iso => { onChange(iso); pop.setOpen(false); };

  const [vy, vm] = view.split('-').map(Number);
  const first = new Date(Date.UTC(vy, vm - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // số ô trống trước ngày 1 (tuần bắt đầu thứ Hai)
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(Date.UTC(vy, vm - 1, 1 + i - lead));
    return { iso: isoOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), day: d.getUTCDate(), inMonth: d.getUTCMonth() === vm - 1 };
  });
  const shift = n => { const d = new Date(Date.UTC(vy, vm - 1 + n, 1)); setView(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`); };
  const canPrev = !min || view > min.slice(0, 7);
  const tomorrow = today && (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const navBtn = 'rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 disabled:pointer-events-none dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer';

  return (
    <>
      <PickerField pop={pop} icon={CalendarDays} label="Ngày" className={className} value={text} inputMode="numeric" maxLength={10} placeholder="dd/mm/yyyy"
        onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); pop.setOpen(false); } }} />
      {pop.render(<div className="p-1">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" aria-label="Tháng trước" disabled={!canPrev} onClick={() => shift(-1)} className={navBtn}><ChevronLeft className="size-4" /></button>
          <span className="text-sm font-semibold">Tháng {vm}, {vy}</span>
          <button type="button" aria-label="Tháng sau" onClick={() => shift(1)} className={navBtn}><ChevronRight className="size-4" /></button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {VN_DOW.map(d => <div key={d} className={cx('pb-1 text-[11px] font-medium', d === 'CN' ? 'text-bad/80' : 'text-zinc-400')}>{d}</div>)}
          {cells.map(c => {
            const on = c.iso === value, dis = !ok(c.iso), isToday = c.iso === today;
            return (
              <button key={c.iso} type="button" disabled={dis} onClick={() => pick(c.iso)}
                className={cx('h-9 rounded-lg text-sm tabular transition-colors cursor-pointer disabled:cursor-default',
                  on ? 'bg-indigo-600 font-semibold text-white'
                    : dis ? 'text-zinc-300 dark:text-zinc-700'
                    : c.inMonth ? 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800' : 'text-zinc-400 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:bg-zinc-800',
                  isToday && !on && 'font-semibold ring-1 ring-inset ring-indigo-600/60 dark:ring-indigo-400/60')}>
                {c.day}
              </button>
            );
          })}
        </div>
        {today && (
          <div className="mt-2 flex gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            {ok(today) && <Button size="sm" variant="secondary" onClick={() => pick(today)}>Hôm nay</Button>}
            {ok(tomorrow) && <Button size="sm" variant="secondary" onClick={() => pick(tomorrow)}>Ngày mai</Button>}
          </div>
        )}
      </div>)}
    </>
  );
}

export const Select = ({ children, ...p }) => <select {...p} className={cx(inputCls, 'pr-8 cursor-pointer', p.className)}>{children}</select>;

export function SearchInput({ value, onChange, placeholder = 'Tìm kiếm…', className }) {
  return (
    <div className={cx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={cx(inputCls, 'pl-9 h-9 py-0')} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start justify-between gap-4 py-2.5 cursor-pointer">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-zinc-500 mt-0.5">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer', checked ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-zinc-300 dark:bg-zinc-700')}>
        <span className={cx('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
      </button>
    </label>
  );
}

export function Tabs({ value, onChange, items }) {
  return (
    <div className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-xl bg-zinc-100 p-0.5 dark:bg-zinc-800/70">
      {items.map(it => (
        <button key={it.value} onClick={() => onChange(it.value)}
          className={cx('flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition cursor-pointer',
            value === it.value ? 'bg-white text-zinc-900 ring-1 ring-zinc-200 dark:bg-zinc-700 dark:text-white dark:ring-zinc-600' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200')}>
          {it.mark || (it.dot && <span className={cx('size-2 rounded-full', it.dot)} />)}
          {it.label}
          {it.count != null && <span className="tabular text-zinc-400">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({ status, size = 'md', pulse }) {
  const st = DEVICE_STATUS[status] || DEVICE_STATUS.offline;
  // Bị ban: tam giác viền đỏ, giống bảng node trên EarnApp (icon "warn", màu error, chú thích "Not earning")
  if (status === 'banned') return <TriangleAlert aria-label={st.label} className={cx('shrink-0 text-bad', size === 'sm' ? 'size-3.5' : 'size-4')} strokeWidth={2.25} />;
  // Chưa rõ: vòng rỗng, khác chấm xám của "rớt mạng"
  if (status === 'unknown') return <span title={st.label} className={cx('inline-block shrink-0 rounded-full ring-[1.5px] ring-inset ring-zinc-400 dark:ring-zinc-500', size === 'sm' ? 'size-2' : 'size-2.5')} />;
  return <span title={st.label} className={cx('inline-block shrink-0 rounded-full', st.color, size === 'sm' ? 'size-2' : 'size-2.5', pulse && status === 'online' && 'dot-pulse')} />;
}

export function DeviceBadge({ status }) {
  const st = DEVICE_STATUS[status] || DEVICE_STATUS.offline;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium" title={st.hint}>
      <StatusDot status={status} pulse />
      <span className={st.text}>{st.label}</span>
    </span>
  );
}

export function Badge({ className, children }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', className)}>{children}</span>;
}

export const GroupTag = ({ name }) => name ? <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-px text-[11px] font-normal text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{name}</span> : null;

/** Tên acc dùng chung mọi trang: tên riêng in đậm + nhãn máy, email nhỏ bên dưới (chưa đặt tên thì email ở dòng chính) */
export function AccName({ label, email, group, sub, extra, className, small }) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cx('truncate', small ? '' : 'font-medium')}>{label || email}</span>
        <GroupTag name={group} />{extra}
      </div>
      {(label || sub) && <div className="truncate text-xs text-zinc-500">{label ? email : null}{label && sub ? ' · ' : null}{sub}</div>}
    </div>
  );
}

/** So sánh acc theo thứ tự chuẩn: máy → tên riêng (A2 trước A10) → email */
const natural = (x, y) => String(x || '').localeCompare(String(y || ''), 'vi', { numeric: true, sensitivity: 'base' });
export const byAccount = (a, b) => (!(a.group_name ?? a.group) - !(b.group_name ?? b.group)) || natural(a.group_name ?? a.group, b.group_name ?? b.group)
  || (!a.label - !b.label) || natural(a.label, b.label) || natural(a.email, b.email);
/** Khoá sắp xếp theo tên cho bảng (tên riêng trước, email sau) */
export const nameKey = a => (a.label ? '0' : '1') + (a.label || '') + ' ' + (a.email || '');

/** Trạng thái dạng chấm + chữ (gọn hơn nhãn màu) */
export function StateText({ dot, label, title, className }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]', className)}>
      <span className={cx('size-1.5 shrink-0 rounded-full', dot)} />{label}
    </span>
  );
}

const ACC_DOT = { running: 'bg-good', stopped: 'bg-warn', banned: 'bg-bad' };
export const AccountBadge = ({ status }) => {
  const st = ACCOUNT_STATUS[status] || ACCOUNT_STATUS.stopped;
  return <StateText dot={ACC_DOT[status] || 'bg-warn'} label={st.label} title={st.hint} className={status === 'banned' ? 'text-bad font-medium' : ''} />;
};

export function Modal({ open, onClose, title, subtitle, children, footer, wide }) {
  useEffect(() => {
    if (!open) return;
    const h = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-zinc-950/45" onClick={onClose} />
      <div className={cx('relative w-full max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white shadow-xl ring-1 ring-zinc-900/5 animate-fade-in dark:bg-zinc-900 dark:ring-1 dark:ring-zinc-800', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-zinc-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 cursor-pointer"><X className="size-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3.5 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && <Icon className="mb-3 size-6 text-zinc-300 dark:text-zinc-600" strokeWidth={1.5} />}
      <p className="text-zinc-600 dark:text-zinc-300">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export const Spinner = ({ className }) => <Loader2 className={cx('size-5 animate-spin text-zinc-400', className)} />;

export function PageLoading() {
  return <div className="flex h-64 items-center justify-center"><Spinner className="size-7" /></div>;
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-zinc-200 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-zinc-800">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// ---------- Toast ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, type = 'success') => {
    const id = Math.random();
    setItems(x => [...x, { id, message, type }]);
    setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-20 lg:bottom-6 right-4 left-4 sm:left-auto z-[60] flex flex-col gap-2 sm:w-80">
        {items.map(t => (
          <div key={t.id} className="flex items-start gap-2.5 rounded-xl bg-indigo-950 px-4 py-3 text-sm text-white shadow-lg animate-fade-in dark:bg-zinc-800 dark:ring-1 dark:ring-zinc-700">
            {t.type === 'error' ? <AlertCircle className="size-5 shrink-0 text-red-400" /> : <CheckCircle2 className="size-5 shrink-0 text-emerald-400" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Hook tải dữ liệu, tự làm mới ----------
export function useData(loader, deps = [], refreshMs = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    try {
      const data = await loader();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState(s => ({ ...s, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(() => document.visibilityState === 'visible' && load(), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { ...state, reload: load };
}

export function ConfirmButton({ onConfirm, children, title = 'Bạn chắc chắn?', message, confirmLabel = 'Xoá', ...p }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  return (
    <>
      <Button {...p} onClick={() => setOpen(true)}>{children}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title}
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button variant="danger" loading={loading} onClick={async () => { setLoading(true); try { await onConfirm(); setOpen(false); } finally { setLoading(false); } }}>{confirmLabel}</Button>
        </>}>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">{message}</p>
      </Modal>
    </>
  );
}
