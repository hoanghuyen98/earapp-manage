import { useMemo, useState } from 'react';
import { HardDrive, Pencil, Trash2, UserPlus, ArrowRightLeft } from 'lucide-react';
import { api, DEVICE_STATUS } from '../lib';
import { Button, PageLoading, Modal, Field, Input, Textarea, Select, Empty, StatusDot, AccName, ConfirmButton, byAccount, useData, useToast } from '../ui';

// Máy = máy thật / VPS chạy nhiều acc EarnApp, mỗi acc chạy nhiều node.
// Quy trình: tạo máy trước -> thêm acc thì chọn máy -> node của acc tự hiện theo máy.
// Quản lý máy nằm ngay trong trang Tài khoản (mỗi máy là 1 dòng tiêu đề, các acc của máy bên dưới).

export const NO_MACHINE = 'Chưa gán máy';
const NEW = '__new__';

/** Danh sách máy đã tạo (không gồm dòng "Chưa gán máy") */
export function useMachines() {
  const r = useData(() => api('/machines'), []);
  return { ...r, machines: (r.data || []).filter(m => m.id != null) };
}

/**
 * Ô chọn máy. Chọn "+ Tạo máy mới…" thì hiện ô nhập tên ngay tại chỗ, tạo xong tự chọn máy đó.
 * required: bắt buộc chọn (thêm acc); allowNone: cho chọn "Chưa gán máy" (sửa acc cũ)
 */
export function MachineSelect({ value, onChange, required, allowNone }) {
  const toast = useToast();
  const { machines, loading, reload } = useMachines();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const noMachines = !loading && !machines.length;
  const showCreate = creating || (required && noMachines);

  const create = async () => {
    setSaving(true);
    try {
      const m = await api('/machines', { method: 'POST', body: { name } });
      await reload();
      onChange(m.name);
      setCreating(false); setName('');
      toast(`Đã tạo "${m.name}"`);
    } catch (e) { toast(e.message, 'error'); } finally { setSaving(false); }
  };

  if (showCreate) {
    return (
      <div className="flex gap-2">
        <Input autoFocus value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Tên máy mới, VD: Máy A"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); name.trim() && create(); } }} />
        <Button type="button" loading={saving} disabled={!name.trim()} onClick={create}>Tạo</Button>
        {!noMachines && <Button type="button" variant="secondary" onClick={() => { setCreating(false); setName(''); }}>Huỷ</Button>}
      </div>
    );
  }
  // Acc cũ đang trỏ tới tên máy không còn (hiếm): vẫn hiện để người dùng thấy và chọn lại
  const unknown = value && !machines.some(m => m.name === value);
  return (
    <Select value={value} onChange={e => e.target.value === NEW ? setCreating(true) : onChange(e.target.value)}>
      {required && !value && <option value="" disabled>— Chọn máy —</option>}
      {allowNone && <option value="">{NO_MACHINE}</option>}
      {unknown && <option value={value}>{value}</option>}
      {machines.map(m => <option key={m.id} value={m.name}>{m.name}{m.note ? ` · ${m.note}` : ''}</option>)}
      <option value={NEW}>+ Tạo máy mới…</option>
    </Select>
  );
}

export function DeviceDots({ d }) {
  const items = Object.keys(DEVICE_STATUS).filter(k => d[k] > 0);
  if (!items.length) return <span className="text-xs text-zinc-400">Chưa có node</span>;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {items.map(k => <span key={k} className="inline-flex items-center gap-1 text-[13px] tabular" title={DEVICE_STATUS[k].label}><StatusDot status={k} size="sm" />{d[k]}</span>)}
    </div>
  );
}

export function MachineModal({ machine, open, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: machine?.name || '', note: machine?.note || '' });
  const [loading, setLoading] = useState(false);
  const save = async () => {
    setLoading(true);
    try {
      const m = await api(machine ? `/machines/${machine.id}` : '/machines', { method: machine ? 'PATCH' : 'POST', body: form });
      toast(machine ? 'Đã lưu' : `Đã tạo "${m.name}"`);
      onSaved(m); onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setLoading(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={machine ? `Sửa "${machine.name}"` : 'Thêm máy'}
      subtitle={machine ? (machine.accounts ? `Đổi tên thì ${machine.accounts} acc của máy đổi theo` : null) : 'Tạo máy trước, rồi thêm tài khoản vào máy'}
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button><Button loading={loading} disabled={!form.name.trim()} onClick={save}>{machine ? 'Lưu' : 'Tạo máy'}</Button></>}>
      <div className="space-y-4">
        <Field label="Tên máy"><Input autoFocus value={form.name} maxLength={40} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="VD: Máy A, VPS-01" /></Field>
        <Field label="Ghi chú" hint="VD: nơi đặt máy, IP, node1 → node20"><Textarea rows={2} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** Chuyển acc đang có (ở máy khác / chưa gán) vào máy này */
export function MoveModal({ machine, open, onClose, onSaved }) {
  const toast = useToast();
  const { data } = useData(() => api('/accounts'), []);
  const [picked, setPicked] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const others = useMemo(() => (data || []).filter(a => !a.archived_at && a.group_name !== machine.name).sort(byAccount), [data, machine.name]);
  const toggle = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const save = async () => {
    setLoading(true);
    try {
      const r = await api('/machines/move', { method: 'POST', body: { ids: [...picked], machine: machine.name } });
      toast(`Đã chuyển ${r.moved} acc vào ${machine.name}`);
      onSaved(); onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setLoading(false); }
  };
  return (
    <Modal open={open} onClose={onClose} wide title={`Chuyển acc vào ${machine.name}`} subtitle="Chọn các acc đang ở máy khác hoặc chưa gán máy"
      footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button><Button loading={loading} disabled={!picked.size} onClick={save}>Chuyển {picked.size || ''} acc</Button></>}>
      {!data ? <PageLoading /> : !others.length ? <Empty icon={HardDrive} title="Không còn acc nào ở máy khác" /> : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {others.map(a => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-3 py-2.5">
                <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} className="size-4 accent-indigo-600" />
                <AccName className="flex-1" label={a.label} email={a.email} />
                <span className="shrink-0 text-xs text-zinc-500">{a.group_name || NO_MACHINE}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Nút của 1 máy: thêm acc mới, chuyển acc có sẵn vào, sửa, xoá (chỉ xoá được khi máy không còn acc) */
export function MachineActions({ m, onAdd, onEdit, onMove, onDelete }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
      <Button size="sm" variant="secondary" icon={UserPlus} onClick={onAdd} title="Thêm acc mới vào máy này">Thêm acc</Button>
      <Button size="sm" variant="secondary" icon={ArrowRightLeft} onClick={onMove} title="Chuyển acc có sẵn vào máy này" />
      <Button size="sm" variant="secondary" icon={Pencil} onClick={onEdit} title="Sửa tên / ghi chú máy" />
      {m.accounts > 0
        // Nút bị khoá không hiện chú thích khi rê chuột, nên đặt chú thích ở thẻ bọc ngoài
        ? <span title="Còn acc trong máy: chuyển hết acc sang máy khác rồi mới xoá được"><Button size="sm" variant="secondary" icon={Trash2} disabled /></span>
        : <ConfirmButton size="sm" variant="secondary" icon={Trash2} title={`Xoá "${m.name}"?`} onConfirm={onDelete}
            message={m.archived ? `${m.archived} acc đã lưu trữ của máy sẽ chuyển về "${NO_MACHINE}".` : 'Máy chưa có acc nào.'} />}
    </div>
  );
}
