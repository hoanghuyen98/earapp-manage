import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertCircle, Search } from 'lucide-react';
import { DEVICE_STATUS, ACCOUNT_STATUS } from './lib';

export const cx = (...a) => a.filter(Boolean).join(' ');

export function Card({ className, children, ...p }) {
  return (
    <div className={cx('rounded-2xl border border-zinc-200/80 bg-white shadow-sm shadow-zinc-900/[.03] dark:border-zinc-800 dark:bg-zinc-900', className)} {...p}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action, icon: Icon }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && <Icon className="size-[18px] shrink-0 text-zinc-400" />}
        <div className="min-w-0">
          <h3 className="font-semibold text-[15px] leading-tight">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

const BTN = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/20',
  secondary: 'bg-white text-zinc-700 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-700/70',
  ghost: 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

export function Button({ variant = 'primary', size = 'md', loading, icon: Icon, className, children, ...p }) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer whitespace-nowrap',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'icon' ? 'size-9' : 'h-10 px-4 text-sm',
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

export const inputCls = 'w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm ring-1 ring-inset ring-zinc-200 placeholder:text-zinc-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none dark:bg-zinc-800/60 dark:ring-zinc-700 dark:focus:ring-indigo-400';

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
export const Select = ({ children, ...p }) => <select {...p} className={cx(inputCls, 'pr-8 cursor-pointer', p.className)}>{children}</select>;

export function SearchInput({ value, onChange, placeholder = 'Tìm kiếm…', className }) {
  return (
    <div className={cx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={cx(inputCls, 'pl-9 py-2')} />
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
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer', checked ? 'bg-indigo-600' : 'bg-zinc-300 dark:bg-zinc-700')}>
        <span className={cx('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
      </button>
    </label>
  );
}

export function Tabs({ value, onChange, items }) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
      {items.map(it => (
        <button key={it.value} onClick={() => onChange(it.value)}
          className={cx('flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition cursor-pointer',
            value === it.value ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200')}>
          {it.dot && <span className={cx('size-2 rounded-full', it.dot)} />}
          {it.label}
          {it.count != null && <span className="tabular text-zinc-400">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({ status, size = 'md', pulse }) {
  const st = DEVICE_STATUS[status] || DEVICE_STATUS.offline;
  return <span title={st.label} className={cx('inline-block shrink-0 rounded-full', st.color, size === 'sm' ? 'size-2' : 'size-2.5', pulse && status === 'online' && 'dot-pulse')} />;
}

export function DeviceBadge({ status }) {
  const st = DEVICE_STATUS[status] || DEVICE_STATUS.offline;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" title={st.hint}>
      <StatusDot status={status} pulse />
      <span className={st.text}>{st.label}</span>
    </span>
  );
}

export function Badge({ className, children }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', className)}>{children}</span>;
}

export const AccountBadge = ({ status }) => {
  const st = ACCOUNT_STATUS[status] || ACCOUNT_STATUS.stopped;
  return <span title={st.hint}><Badge className={st.cls}>{st.label}</Badge></span>;
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
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cx('relative w-full max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl animate-fade-in dark:bg-zinc-900 dark:ring-1 dark:ring-zinc-800', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
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
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {Icon && <div className="mb-3 rounded-2xl bg-zinc-100 p-3 dark:bg-zinc-800"><Icon className="size-6 text-zinc-400" /></div>}
      <p className="font-medium">{title}</p>
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
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
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
          <div key={t.id} className="flex items-start gap-2.5 rounded-xl bg-zinc-900 px-4 py-3 text-sm text-white shadow-xl animate-fade-in dark:bg-zinc-800 dark:ring-1 dark:ring-zinc-700">
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
