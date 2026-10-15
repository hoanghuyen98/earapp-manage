import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Users, Server, Wallet, BarChart3, Settings, LogOut, Moon, Sun } from 'lucide-react';
import { api } from './lib';
import { cx } from './ui';

const NAV = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Tài khoản', icon: Users },
  { to: '/devices', label: 'Node', icon: Server },
  { to: '/payouts', label: 'Rút tiền', icon: Wallet },
  { to: '/reports', label: 'Báo cáo', icon: BarChart3 },
  { to: '/settings', label: 'Cài đặt', icon: Settings },
];

export function Logo({ className }) {
  return (
    <div className={cx('flex items-center gap-2.5', className)}>
      <img src="/favicon.svg" alt="" className="size-7" />
      <div className="text-[15px] font-semibold tracking-tight">EarnApp <span className="font-normal text-zinc-400">Manager</span></div>
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
    <div className="min-h-dvh lg:pl-60">
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-zinc-200 bg-white px-3 py-5 lg:flex dark:border-zinc-800 dark:bg-zinc-900">
        <Logo className="px-3" />
        <nav className="mt-8 flex flex-1 flex-col gap-0.5">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors',
                isActive ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200' : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100')}>
              <n.icon className="size-4" strokeWidth={1.75} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-3 pt-4 dark:border-zinc-800">
          <span className="truncate text-[13px] text-zinc-500">{user}</span>
          <div className="flex">
            <button onClick={toggleTheme} title={dark ? 'Giao diện sáng' : 'Giao diện tối'} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
            <button onClick={logout} title="Đăng xuất" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer"><LogOut className="size-4" /></button>
          </div>
        </div>
      </aside>

      {/* Header mobile */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2.5 pt-[max(.625rem,env(safe-area-inset-top))] lg:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <Logo />
        <div className="flex">
          <button onClick={toggleTheme} title={dark ? 'Giao diện sáng' : 'Giao diện tối'} className="rounded-md p-2 text-zinc-400 cursor-pointer">{dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}</button>
          <button onClick={logout} title="Đăng xuất" className="rounded-md p-2 text-zinc-400 cursor-pointer"><LogOut className="size-[18px]" /></button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pt-6 pb-28 sm:px-6 lg:px-10 lg:pt-9 lg:pb-12">
        <Outlet />
      </main>

      {/* Thanh điều hướng dưới (mobile) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden dark:border-zinc-800 dark:bg-zinc-900">
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => cx('flex flex-col items-center gap-1 py-2 text-[10.5px]', isActive ? 'font-medium text-indigo-600 dark:text-indigo-300' : 'text-zinc-400')}>
            {({ isActive }) => <><n.icon className="size-5" strokeWidth={isActive ? 2 : 1.6} />{n.label}</>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
