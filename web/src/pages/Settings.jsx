import { useEffect, useState } from 'react';
import { Send, Save, Download, HelpCircle, LogOut } from 'lucide-react';
import { api, vnd } from '../lib';
import { Card, CardHeader, Button, PageHeader, PageLoading, Field, Input, Toggle, ConfirmButton, useToast } from '../ui';

const NOTIFY = [
  ['notify_offline', 'Node rớt mạng'],
  ['notify_online', 'Node hoạt động lại'],
  ['notify_idle', 'Node lâu không tăng tiền'],
  ['notify_device_banned', 'Node bị ban'],
  ['notify_account_banned', 'Tài khoản bị khoá'],
  ['notify_suspect', 'Tài khoản nghi bị khoá', 'Node biến mất hết hoặc số dư tụt bất thường'],
  ['notify_auth', 'Cookie hết hạn'],
  ['notify_sync_error', 'Không lấy được dữ liệu'],
  ['notify_rate_limit', 'Bị EarnApp giới hạn'],
  ['notify_payout', 'Lệnh rút mới, tiền về'],
  ['notify_withdraw', 'Kết quả rút theo lịch'],
  ['notify_withdraw_skipped', 'Báo khi bỏ qua vì chưa đủ tiền rút', 'Số dư dưới mức tối thiểu ($10 PayPal/Wise) nên không rút. Tắt để đỡ spam, vẫn xem được trong Nhật ký rút'],
];

function NumberRow({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

const NumInput = ({ value, onChange }) => (
  <div className="w-20">
    <Input type="number" min={1} value={value} onChange={e => onChange(e.target.value)} className="text-center tabular" />
  </div>
);
const Unit = ({ children }) => <span className="w-9 text-sm text-zinc-500">{children}</span>;

export default function Settings() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });

  useEffect(() => { api('/settings').then(setS); }, []);
  if (!s) return <PageLoading />;
  const set = (k, v) => setS({ ...s, [k]: v });

  const save = async () => {
    setSaving(true);
    try { await api('/settings', { method: 'PUT', body: s }); toast('Đã lưu cài đặt'); setS(await api('/settings')); }
    catch (e) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try { await api('/settings', { method: 'PUT', body: s }); const r = await api('/settings/telegram-test', { method: 'POST' }); toast(r.sent > 1 ? `Đã gửi tin thử tới ${r.sent} nơi` : 'Đã gửi tin thử'); setS(await api('/settings')); }
    catch (e) { toast(e.message, 'error'); } finally { setTesting(false); }
  };
  const changePw = async () => {
    if (pw.next !== pw.confirm) return toast('Mật khẩu nhập lại không khớp', 'error');
    try { await api('/password', { method: 'POST', body: pw }); toast('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất'); setPw({ current: '', next: '', confirm: '' }); }
    catch (e) { toast(e.message, 'error'); }
  };

  return (
    <>
      <PageHeader title="Cài đặt">
        <Button icon={Save} loading={saving} onClick={save}>Lưu</Button>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Thông báo Telegram" />
          <div className="space-y-4 px-5 pb-5">
            <details className="rounded-xl bg-indigo-50/60 px-4 py-3 text-[13px] text-zinc-700 dark:bg-indigo-500/5 dark:text-zinc-300">
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-indigo-700 dark:text-indigo-300"><HelpCircle className="size-4" /> Cách cài đặt</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>Mở Telegram, tìm <b>@BotFather</b>, gửi lệnh <code>/newbot</code> rồi đặt tên. BotFather sẽ gửi lại <b>Bot token</b>.</li>
                <li>Mở bot vừa tạo và bấm <b>Start</b> (hoặc thêm bot vào nhóm).</li>
                <li>Chat riêng: tìm <b>@userinfobot</b>, bấm Start để lấy Chat ID. Nhóm: thêm <b>@getidsbot</b> vào nhóm để lấy ID (số âm, VD -100…), lấy xong xoá bot đó ra.</li>
                <li>Dán 2 thông tin vào đây rồi bấm <b>Gửi thử</b>.</li>
              </ol>
            </details>
            <Field label="Bot token"><Input value={s.telegram_token} onChange={e => set('telegram_token', e.target.value)} placeholder="123456789:AAH..." className="font-mono text-xs" /></Field>
            <Field label="Chat ID" hint="Nhiều nơi nhận: cách nhau bằng dấu phẩy. Nhóm là số âm."><Input value={s.telegram_chat_id} onChange={e => set('telegram_chat_id', e.target.value)} placeholder="-1001234567890, 123456789" className="font-mono text-xs" /></Field>
            <Button variant="secondary" icon={Send} loading={testing} onClick={test}>Gửi thử</Button>
            <div className="divide-y divide-zinc-100 border-t border-zinc-100 pt-2 dark:divide-zinc-800 dark:border-zinc-800">
              {NOTIFY.map(([k, l, h]) => <Toggle key={k} checked={!!s[k]} onChange={v => set(k, v)} label={l} hint={h} />)}
              <Toggle checked={!!s.daily_report} onChange={v => set('daily_report', v)} label="Báo cáo hằng ngày" />
              {s.daily_report && (
                <div className="py-2.5">
                  <Field label="Giờ gửi báo cáo"><Input type="number" min={0} max={23} value={s.daily_report_hour} onChange={e => set('daily_report_hour', e.target.value)} className="w-28" /></Field>
                </div>
              )}
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Lấy dữ liệu & cảnh báo" />
            <div className="divide-y divide-zinc-100 px-5 pb-3 dark:divide-zinc-800">
              <NumberRow label="Mỗi acc lấy dữ liệu" hint="Nên 5–10 phút">
                <NumInput value={s.sync_min_min} onChange={v => set('sync_min_min', v)} />
                <span className="text-sm text-zinc-500">–</span>
                <NumInput value={s.sync_max_min} onChange={v => set('sync_max_min', v)} />
                <Unit>phút</Unit>
              </NumberRow>
              <NumberRow label="Giãn cách giữa 2 acc">
                <NumInput value={s.account_delay_sec} onChange={v => set('account_delay_sec', v)} />
                <Unit>giây</Unit>
              </NumberRow>
              <NumberRow label="Báo rớt mạng sau">
                <NumInput value={s.offline_grace_min} onChange={v => set('offline_grace_min', v)} />
                <Unit>phút</Unit>
              </NumberRow>
              <NumberRow label="Báo &quot;lâu không tăng tiền&quot; sau" hint="Khi node khác cùng acc vẫn ra tiền. Cả acc đứng yên thì chờ 24 giờ">
                <NumInput value={s.idle_hours} onChange={v => set('idle_hours', v)} />
                <Unit>giờ</Unit>
              </NumberRow>
              <NumberRow label="Báo lỗi sau">
                <NumInput value={s.error_alert_count} onChange={v => set('error_alert_count', v)} />
                <Unit>lần</Unit>
              </NumberRow>
              {Number(s.sync_max_min) < Number(s.sync_min_min) && (
                <p className="py-2 text-sm text-bad">Số phút tối đa phải ≥ tối thiểu.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Tỷ giá" />
            <div className="px-5 pb-5">
              <Field label="1 USD = ? VNĐ" hint={`$10 ≈ ${vnd(10 * (Number(s.usd_vnd) || 0))}`}>
                <Input type="number" value={s.usd_vnd} onChange={e => set('usd_vnd', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Xuất Excel" />
            <div className="flex flex-wrap gap-2 px-5 pb-5">
              <a href="/api/export/accounts"><Button variant="secondary" size="sm" icon={Download}>Tài khoản</Button></a>
              <a href="/api/export/devices"><Button variant="secondary" size="sm" icon={Download}>Node</Button></a>
              <a href="/api/export/transactions"><Button variant="secondary" size="sm" icon={Download}>Lịch sử rút</Button></a>
              <a href="/api/export/usage"><Button variant="secondary" size="sm" icon={Download}>Dung lượng</Button></a>
              <a href="/api/export/snapshots"><Button variant="secondary" size="sm" icon={Download}>Lịch sử số dư</Button></a>
            </div>
          </Card>

          <Card>
            <CardHeader title="Sao lưu" />
            <div className="space-y-3 px-5 pb-5">
              <a href="/api/backup"><Button variant="secondary" size="sm" icon={Download}>Tải file sao lưu</Button></a>
              <p className="text-xs text-zinc-500">File chứa cookie các acc và khoá giải mã. Không gửi cho người khác.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Mật khẩu" />
            <div className="space-y-3 px-5 pb-5">
              <Input type="password" placeholder="Mật khẩu hiện tại" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Input type="password" placeholder="Mật khẩu mới" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
                <Input type="password" placeholder="Nhập lại mật khẩu mới" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={changePw} disabled={!pw.current || !pw.next}>Đổi mật khẩu</Button>
                <ConfirmButton variant="secondary" icon={LogOut} title="Đăng xuất các thiết bị khác?" confirmLabel="Đăng xuất"
                  message="Các thiết bị khác phải đăng nhập lại. Thiết bị này vẫn giữ đăng nhập."
                  onConfirm={async () => { await api('/logout-others', { method: 'POST' }); toast('Đã đăng xuất các thiết bị khác'); }}>Đăng xuất thiết bị khác</ConfirmButton>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
