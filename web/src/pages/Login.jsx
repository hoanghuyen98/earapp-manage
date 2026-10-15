import { useState } from 'react';
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
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <Logo className="mb-6" />
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold">Đăng nhập</h1>
        <div className="mt-5 space-y-4">
          <Field label="Tên đăng nhập">
            <Input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="username" />
          </Field>
          <Field label="Mật khẩu">
            <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="current-password" autoFocus />
          </Field>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">Đăng nhập</Button>
        </div>
      </form>
    </div>
  );
}
