import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, XCircle, X, ChevronDown, RotateCcw, Pencil } from 'lucide-react';
import { api } from './lib';
import { ProgressRow, ProxyField } from './pages/Accounts';
import { Button, useToast, cx } from './ui';

// Thêm acc chạy ngầm: thẻ ở đầu mọi trang cho biết đang thêm tới đâu, xong thì báo kết quả.
// Hỏi server 2 giây/lần khi có lượt đang chạy, không thì 20 giây/lần.

const accName = r => r.label ? `${r.label} (${r.email})` : r.email;
const syncDone = r => ['done', 'error'].includes(r.sync?.state);

function JobCard({ job, onDismiss, onRetry }) {
  const [open, setOpen] = useState(false);
  // Proxy admin sửa cho dòng lỗi mạng / proxy: { số dòng: proxy }. Chưa sửa thì dùng proxy cũ
  const [proxies, setProxies] = useState({});
  const [retrying, setRetrying] = useState(false);
  const proxyOf = r => proxies[r.line] ?? r.proxy ?? '';
  const changed = job.items.filter(r => r.retry && proxyOf(r) !== (r.proxy ?? '')).length;
  const retry = async () => {
    setRetrying(true);
    try { await onRetry(Object.fromEntries(job.items.filter(r => r.retry).map(r => [r.line, proxyOf(r)]))); }
    finally { setRetrying(false); }
  };
  const running = !job.finished_at;
  const bad = job.failed + job.sync_failed;
  // Tiến độ: kiểm tra cookie 30%, tải dữ liệu lần đầu 70%
  const loadedPart = job.items.filter(r => r.ok).reduce((s, r) => s + (syncDone(r) ? 1 : (r.sync?.percent || 0) / 100), 0) + job.failed;
  const pct = running ? Math.round(((job.checked / job.total) * 0.3 + (loadedPart / job.total) * 0.7) * 100) : 100;
  const where = job.group_name ? ` vào ${job.group_name}` : '';
  const verb = job.kind === 'import' ? 'nhập' : 'thêm';
  const what = job.kind === 'import' ? `${job.total} acc từ file` : `${job.total} acc${where}`;
  const Icon = running ? Loader2 : bad ? AlertTriangle : CheckCircle2;
  const waiting = job.total - job.checked;

  return (
    <div className={cx('rounded-2xl px-4 py-3 ring-1', running ? 'bg-white ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800'
      : bad ? 'bg-amber-50 ring-amber-200 dark:bg-amber-500/10 dark:ring-amber-500/20' : 'bg-emerald-50 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/20')}>
      <div className="flex items-start gap-3">
        <Icon className={cx('mt-0.5 size-5 shrink-0', running ? 'animate-spin text-indigo-500' : bad ? 'text-amber-500' : 'text-emerald-500')} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{running ? `Đang ${verb} ${what}` : `Xong lượt ${verb} ${what}`}</div>
          <div className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-300">
            {running
              ? <>{job.kind !== 'import' && <>Đã kiểm tra {job.checked}/{job.total} · </>}đã tải dữ liệu {job.loaded}/{job.total} acc · bạn cứ làm việc khác, xong sẽ báo</>
              : [job.added && `${job.added} acc mới`, job.updated && `${job.updated} cập nhật cookie`,
                  job.failed && <span key="f" className="font-medium text-bad">{job.failed} không thêm được</span>,
                  job.sync_failed && <span key="s" className="font-medium text-amber-700 dark:text-amber-400">{job.sync_failed} chưa lấy được dữ liệu</span>]
                .filter(Boolean).map((x, i) => <span key={i}>{i > 0 && ' · '}{x}</span>)}
          </div>
          {running && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-700" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.retryable > 0 && !open && <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setOpen(true)} className="hidden sm:inline-flex">Sửa proxy, thêm lại {job.retryable} acc</Button>}
          <button onClick={() => setOpen(!open)} title="Chi tiết" className="rounded-lg p-1.5 text-zinc-400 hover:bg-black/5 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200">
            <ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} />
          </button>
          {!running && <button onClick={onDismiss} title="Đóng thông báo" className="rounded-lg p-1.5 text-zinc-400 hover:bg-black/5 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200"><X className="size-4" /></button>}
        </div>
      </div>
      {job.retryable > 0 && !open && <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setOpen(true)} className="mt-2 ml-8 sm:hidden">Sửa proxy, thêm lại {job.retryable} acc</Button>}
      {open && job.retryable > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-8">
          <Button size="sm" icon={RotateCcw} loading={retrying} onClick={retry}>Thêm lại {job.retryable} acc</Button>
          <span className="text-xs text-zinc-500">{changed ? `Đã sửa proxy ${changed} acc. ` : 'Sửa proxy ở ô bên dưới (để trống = không dùng proxy). '}Cookie, tên giữ nguyên.</span>
        </div>
      )}
      {open && (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto pl-8">
          {job.items.map(r => r.ok
            ? <ProgressRow key={r.line} p={r.sync} name={<>{accName(r)}{r.updated && <span className="font-normal text-zinc-500"> · acc đã có, đã cập nhật cookie{r.moved ? ` và chuyển sang ${r.moved}` : ''}</span>}</>} />
            : (
              <li key={r.line} className="flex items-start gap-2.5 rounded-xl bg-white/70 px-3 py-2.5 text-sm dark:bg-zinc-800/60">
                <XCircle className="size-5 shrink-0 text-red-500" />
                <div className="min-w-0 flex-1">
                  <div><b>Acc {r.line}{r.label ? ` (${r.label})` : ''}:</b> {r.reason}</div>
                  {r.retry && (
                    <div className="mt-2">
                      <ProxyField compact id={`job-${job.id}-proxy-${r.line}`} value={proxyOf(r)} onChange={v => setProxies(p => ({ ...p, [r.line]: v }))} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          {waiting > 0 && <li className="px-3 text-xs text-zinc-500">Còn {waiting} acc đang chờ kiểm tra cookie…</li>}
        </ul>
      )}
    </div>
  );
}

export default function AddJobs() {
  const toast = useToast();
  const [jobs, setJobs] = useState([]);
  const prev = useRef(null); // lần hỏi trước: id -> { finished, checked, loaded }

  useEffect(() => {
    let stop = false, t;
    const load = async () => {
      clearTimeout(t);
      let list = null;
      try { list = await api('/add-jobs'); } catch { /* mạng chập chờn: lần sau hỏi lại */ }
      if (stop) return;
      if (list) {
        const before = prev.current;
        let changed = false;
        for (const j of list) {
          const p = before?.[j.id];
          if (before && (!p || p.checked !== j.checked || p.loaded !== j.loaded || p.finished !== !!j.finished_at)) changed = true;
          // Vừa xong trong lúc đang mở web: báo ngay
          if (p && !p.finished && j.finished_at) {
            const bad = j.failed + j.sync_failed;
            const verb = j.kind === 'import' ? 'Nhập' : 'Thêm';
            toast(bad ? `${verb} acc xong: ${j.loaded}/${j.total} acc ổn, ${bad} acc cần xem lại` : `${verb} xong ${j.total} acc${j.group_name ? ` vào ${j.group_name}` : ''}`, bad ? 'error' : 'success');
          }
        }
        prev.current = Object.fromEntries(list.map(j => [j.id, { finished: !!j.finished_at, checked: j.checked, loaded: j.loaded }]));
        if (changed) window.dispatchEvent(new Event('accounts:changed'));
        setJobs(list);
      }
      t = setTimeout(load, list?.some(j => !j.finished_at) ? 2000 : 20000);
    };
    load();
    window.addEventListener('addjobs:refresh', load);
    return () => { stop = true; clearTimeout(t); window.removeEventListener('addjobs:refresh', load); };
  }, []); // eslint-disable-line

  if (!jobs.length) return null;
  const dismiss = async id => {
    setJobs(js => js.filter(j => j.id !== id));
    await api(`/add-jobs/${id}/dismiss`, { method: 'POST' }).catch(() => {});
  };
  const retry = async (id, proxies) => {
    try {
      await api(`/add-jobs/${id}/retry`, { method: 'POST', body: { proxies } });
      toast('Đang thêm lại các acc lỗi ở nền');
      window.dispatchEvent(new Event('addjobs:refresh'));
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="mb-5 space-y-2">
      {jobs.map(j => <JobCard key={j.id} job={j} onDismiss={() => dismiss(j.id)} onRetry={proxies => retry(j.id, proxies)} />)}
    </div>
  );
}
