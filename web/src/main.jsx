import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import { api } from './lib';
import { ToastProvider, PageLoading } from './ui';
import Layout from './Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Accounts from './pages/Accounts';
import AccountDetail from './pages/AccountDetail';
import Devices from './pages/Devices';
import Payouts from './pages/Payouts';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Backup from './pages/Backup';

function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    api('/me').then(r => setUser(r.username)).catch(() => setUser(null));
    const onLogout = () => setUser(null);
    window.addEventListener('auth:logout', onLogout);
    return () => window.removeEventListener('auth:logout', onLogout);
  }, []);

  if (user === undefined) return <PageLoading />;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <Routes>
      <Route element={<Layout user={user} onLogout={() => setUser(null)} />}>
        <Route index element={<Dashboard />} />
        <Route path="machines" element={<Navigate to="/accounts" replace />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="accounts/:id" element={<AccountDetail />} />
        <Route path="devices" element={<Devices />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="reports" element={<Reports />} />
        <Route path="backup" element={<Backup />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
