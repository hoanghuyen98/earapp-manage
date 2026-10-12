import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { api } from '../lib';
import { Button, Field, Input } from '../ui';
import { Logo } from '../Layout';

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: 'admin', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const r = await api('/login', { method: 'POST', body: form });
      onLogin(r.username);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-indigo-400/20 blur-3xl dark:bg-indigo-600/15" />
      <form onSubmit={submit} className="relative w-full max-w-sm rounded-2xl border border-zinc-200/80 bg-white p-7 shadow-xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">Đăng nhập</h1>
        <p className="mt-1 text-sm text-zinc-500">Quản lý và theo dõi các tài khoản EarnApp</p>
        <div className="mt-6 space-y-4">
          <Field label="Tên đăng nhập">
            <Input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="username" />
          </Field>
          <Field label="Mật khẩu">
            <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="current-password" autoFocus />
          </Field>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">{error}</p>}
          <Button type="submit" loading={loading} icon={LogIn} className="w-full">Đăng nhập</Button>
        </div>
      </form>
    </div>
  );
}
