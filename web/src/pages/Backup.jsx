import { useRef, useState } from 'react';
import { Download, Upload, FileDown, FileUp, AlertTriangle, Loader2, ChevronDown, ShieldCheck } from 'lucide-react';
import { api, uploadFile, downloadPost, fmtDateTime, fmtBytes } from '../lib';
import { Card, Button, Modal, Field, Input, PageHeader, useToast, cx } from '../ui';

// Trang Sao lưu (xem server/backup.js)
// - Tải file sao lưu (.zip) / nhập file sao lưu: thay hẳn dữ liệu web này bằng dữ liệu trong file. Dùng khi đổi VPS
// - Nâng cao: tải / nhập file acc (.json): gộp acc vào web đang có acc khác, không xoá gì

function pickFile(ref, accept, onPick) {
  return (
    <input ref={ref} type="file" accept={accept} hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
  );
}

/** Khôi phục: chọn file -> server kiểm tra, hiện tóm tắt -> đồng ý -> web khởi động lại */
function RestoreModal({ check, onClose }) {
  const [state, setState] = useState('confirm'); // confirm | applying | waiting
  const [error, setError] = useState('');
  const s = check.summary;
  const apply = async () => {
    setState('applying'); setError('');
    try {
      await api('/restore/apply', { method: 'POST' });
      setState('waiting');
      // Chờ web bật lại rồi tải lại trang (có thể phải đăng nhập lại bằng mật khẩu trong file sao lưu)
      await new Promise(r => setTimeout(r, 2500));
      for (let i = 0; i < 60; i++) {
        const ok = await fetch('/api/me', { credentials: 'same-origin' }).then(r => r.status === 200 || r.status === 401).catch(() => false);
        if (ok) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      window.location.href = '/';
    } catch (e) { setError(e.message); setState('confirm'); }
  };
  const cancel = () => { api('/restore', { method: 'DELETE' }).catch(() => {}); onClose(); };

  if (state === 'waiting') {
    return (
      <Modal open onClose={() => {}} title="Đang nhập file sao lưu">
        <div className="flex items-center gap-3 py-4 text-sm"><Loader2 className="size-5 animate-spin text-indigo-500" />Web đang khởi động lại, chờ vài giây…</div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={cancel} title="Nhập file sao lưu?" subtitle={check.name}
      footer={<>
        <Button variant="secondary" onClick={cancel} disabled={state === 'applying'}>Huỷ</Button>
        <Button variant="danger" loading={state === 'applying'} onClick={apply}>Nhập và thay dữ liệu</Button>
      </>}>
      <div className="space-y-4 text-sm">
        <div className="rounded-xl bg-zinc-50 px-4 py-3 dark:bg-zinc-800/60">
          <div className="mb-1 font-medium">File sao lưu có:</div>
          <ul className="space-y-0.5 text-zinc-700 dark:text-zinc-300">
            <li>• {s.machines} máy, {s.accounts} acc đang theo dõi{s.archived ? ` (+${s.archived} acc lưu trữ)` : ''}, {s.devices} node</li>
            <li>• Dữ liệu mới nhất lúc {s.last_data_at ? fmtDateTime(s.last_data_at) : '—'}</li>
          </ul>
        </div>
        <div className="flex gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p><b>Dữ liệu hiện tại sẽ bị thay</b> (bản cũ cất ở <code>data/truoc-khoi-phuc-…</code>).</p>
            <p>Sau đó đăng nhập bằng <b>mật khẩu web cũ</b>.</p>
          </div>
        </div>
        {error && <p className="text-bad">{error}</p>}
      </div>
    </Modal>
  );
}

function ExportModal({ onClose }) {
  const toast = useToast();
  const [pw, setPw] = useState({ a: '', b: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mismatch = pw.b && pw.a !== pw.b;
  const go = async () => {
    setLoading(true); setError('');
    try {
      await downloadPost('/accounts-file/export', { password: pw.a });
      toast('Đã tải file. Nhớ mật khẩu để mở lại');
      onClose();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  return (
    <Modal open onClose={onClose} title="Tải file acc" subtitle="Đặt mật khẩu cho file"
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button>
        <Button icon={FileDown} loading={loading} disabled={pw.a.length < 6 || pw.a !== pw.b} onClick={go}>Tải file</Button></>}>
      <div className="space-y-3">
        <Field label="Mật khẩu" hint="Tối thiểu 6 ký tự">
          <Input type="password" autoComplete="new-password" value={pw.a} onChange={e => setPw({ ...pw, a: e.target.value })} />
        </Field>
        <Field label="Nhập lại mật khẩu" hint={mismatch ? <span className="text-bad">Hai mật khẩu chưa giống nhau</span> : null}>
          <Input type="password" autoComplete="new-password" value={pw.b} onChange={e => setPw({ ...pw, b: e.target.value })} onKeyDown={e => e.key === 'Enter' && pw.a.length >= 6 && pw.a === pw.b && go()} />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </Modal>
  );
}

function ImportModal({ onClose }) {
  const toast = useToast();
  const ref = useRef(null);
  const [file, setFile] = useState(null);
  const [pw, setPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setLoading(true); setError('');
    try {
      const r = await uploadFile('/accounts-file/import', file, { 'x-file-password': encodeURIComponent(pw) });
      const parts = [r.added && `${r.added} acc mới`, r.updated && `${r.updated} acc cập nhật`, r.machines_added && `${r.machines_added} máy mới`].filter(Boolean);
      toast(`Đã nhập ${parts.join(', ') || '0 acc'}.${r.syncing ? ' Đang tải dữ liệu ở nền, xong sẽ báo' : ''}`);
      window.dispatchEvent(new Event('addjobs:refresh'));
      window.dispatchEvent(new Event('accounts:changed'));
      onClose();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  return (
    <Modal open onClose={onClose} title="Nhập file acc"
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button>
        <Button icon={FileUp} loading={loading} disabled={!file || !pw} onClick={go}>Nhập</Button></>}>
      <div className="space-y-3">
        <Field label="File acc (.json)">
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" icon={Upload} onClick={() => ref.current?.click()}>Chọn file</Button>
            <span className="truncate text-sm text-zinc-500">{file ? `${file.name} · ${fmtBytes(file.size)}` : 'Chưa chọn'}</span>
          </div>
          {pickFile(ref, '.json,application/json', setFile)}
        </Field>
        <Field label="Mật khẩu file"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && file && pw && go()} /></Field>
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </Modal>
  );
}

/** 1 việc chính: biểu tượng, tên việc, giải thích, nút */
function Action({ icon: Icon, tone, title, children, button }) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-center gap-3">
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl', tone)}><Icon className="size-5" /></span>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className="mt-3 flex-1 space-y-2 text-sm text-zinc-600 dark:text-zinc-300">{children}</div>
      <div className="mt-5">{button}</div>
    </Card>
  );
}

const STEPS = [
  ['Web cũ', <>Bấm <b>Tải file sao lưu</b></>],
  ['VPS mới', <>Cài web</>],
  ['Web mới', <>Bấm <b>Chọn file sao lưu</b>, đăng nhập bằng mật khẩu web cũ</>],
];

export default function Backup() {
  const toast = useToast();
  const zipRef = useRef(null);
  const [checking, setChecking] = useState(false);
  const [restore, setRestore] = useState(null); // { name, summary }
  const [modal, setModal] = useState(null); // 'export' | 'import'
  const [advanced, setAdvanced] = useState(false);
  const check = async f => {
    setChecking(true);
    try { setRestore({ name: f.name, summary: await uploadFile('/restore/check', f) }); }
    catch (e) { toast(e.message, 'error'); } finally { setChecking(false); }
  };
  return (
    <>
      <PageHeader title="Sao lưu & chuyển VPS" />

      <div className="grid gap-4 md:grid-cols-2">
        <Action icon={Download} tone="bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300" title="Tải về"
          button={<a href="/api/backup"><Button icon={Download}>Tải file sao lưu</Button></a>}>
          <p>Toàn bộ dữ liệu: máy, acc, proxy, lịch sử, cài đặt.</p>
        </Action>
        <Action icon={Upload} tone="bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300" title="Nhập vào"
          button={<>
            <Button variant="secondary" icon={Upload} loading={checking} onClick={() => zipRef.current?.click()}>{checking ? 'Đang kiểm tra file…' : 'Chọn file sao lưu'}</Button>
            {pickFile(zipRef, '.zip,application/zip', check)}
          </>}>
          <p>Chọn file sao lưu. Dữ liệu hiện tại sẽ bị thay.</p>
        </Action>
      </div>

      <Card className="mt-4 p-5">
        <h2 className="text-base font-semibold">Đổi VPS</h2>
        <ol className="mt-4 grid gap-4 md:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <li key={i} className="flex gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-[13px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">{i + 1}</span>
              <div className="text-sm">
                <div className="font-medium">{title}</div>
                <p className="mt-0.5 text-zinc-500">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-zinc-100/70 px-4 py-3 text-[13px] text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        File có cookie các acc, giữ kín.
      </div>

      <Card className="mt-6">
        <button onClick={() => setAdvanced(!advanced)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left cursor-pointer">
          <div>
            <div className="text-sm font-medium">Nâng cao: chỉ chuyển acc</div>
            <div className="mt-0.5 text-xs text-zinc-500">Gộp acc vào web khác, không xoá dữ liệu ở đó</div>
          </div>
          <ChevronDown className={cx('size-4 shrink-0 text-zinc-400 transition-transform', advanced && 'rotate-180')} />
        </button>
        {advanced && (
          <div className="space-y-3 border-t border-zinc-100 px-5 py-4 text-sm dark:border-zinc-800">
            <p className="text-zinc-600 dark:text-zinc-300">Chỉ máy và acc, file khoá bằng mật khẩu. Acc đã có thì cập nhật cookie, proxy.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={FileDown} onClick={() => setModal('export')}>Tải file acc</Button>
              <Button variant="secondary" size="sm" icon={FileUp} onClick={() => setModal('import')}>Nhập file acc</Button>
            </div>
          </div>
        )}
      </Card>

      {restore && <RestoreModal check={restore} onClose={() => setRestore(null)} />}
      {modal === 'export' && <ExportModal onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal onClose={() => setModal(null)} />}
    </>
  );
}
