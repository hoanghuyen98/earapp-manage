import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Users, Server, Wallet, BarChart3, Settings, LogOut, Moon, Sun } from 'lucide-react';
import { api } from './lib';
import { cx } from './ui';

const NAV = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Tài khoản', icon: Users },
  { to: '/devices', label: 'Máy', icon: Server },
  { to: '/payouts', label: 'Rút tiền', icon: Wallet },
  { to: '/reports', label: 'Báo cáo', icon: BarChart3 },
  { to: '/settings', label: 'Cài đặt', icon: Settings },
];

export function Logo({ className }) {
  return (
    <div className={cx('flex items-center gap-2.5', className)}>
      <img src="/favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <div className="font-semibold tracking-tight">EarnApp</div>
        <div className="text-[11px] text-zinc-500">Manager</div>
      </div>
    </div>
  );
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
    setDark(next);
  };
  return [dark, toggle];
}

export default function Layout({ user, onLogout }) {
  const [dark, toggleTheme] = useTheme();
  const logout = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); onLogout(); };

  return (
    <div className="min-h-dvh lg:pl-64">
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-zinc-200/80 bg-white px-4 py-5 lg:flex dark:border-zinc-800 dark:bg-zinc-900">
        <Logo className="px-2" />
        <nav className="mt-8 flex flex-1 flex-col gap-1">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                isActive ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100')}>
              <n.icon className="size-[18px]" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200/80 p-2 pl-3 dark:border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex size-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold uppercase text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">{user[0]}</div>
            <span className="truncate text-sm font-medium">{user}</span>
          </div>
          <div className="flex">
            <button onClick={toggleTheme} title="Đổi giao diện sáng/tối" className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
            <button onClick={logout} title="Đăng xuất" className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"><LogOut className="size-4" /></button>
          </div>
        </div>
      </aside>

      {/* Header mobile */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200/80 bg-white/85 px-4 py-3 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-900/85">
        <Logo />
        <div className="flex">
          <button onClick={toggleTheme} className="rounded-lg p-2 text-zinc-500 cursor-pointer">{dark ? <Sun className="size-5" /> : <Moon className="size-5" />}</button>
          <button onClick={logout} className="rounded-lg p-2 text-zinc-500 cursor-pointer"><LogOut className="size-5" /></button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-12">
        <Outlet />
      </main>

      {/* Thanh điều hướng dưới (mobile) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-zinc-200/80 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-900/95">
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => cx('flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium', isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500')}>
            <n.icon className="size-5" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
