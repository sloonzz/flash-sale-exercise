import { useState } from 'react';
import { AdminGateForm } from '../components/AdminGateForm.tsx';
import { AdminSaleForm } from '../components/AdminSaleForm.tsx';

const ADMIN_KEY_STORAGE_KEY = 'flashSale.adminKey';

export function AdminPage() {
  const [adminKey, setAdminKey] = useState(
    () => localStorage.getItem(ADMIN_KEY_STORAGE_KEY) ?? '',
  );

  function login(key: string) {
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, key);
    setAdminKey(key);
  }

  function logout() {
    localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    setAdminKey('');
  }

  if (!adminKey) {
    return (
      <section className="panel">
        <h1>Admin</h1>
        <AdminGateForm onLogin={login} />
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="admin-header">
        <h1>Admin</h1>
        <button type="button" className="link-button" onClick={logout}>
          Logout
        </button>
      </div>

      <AdminSaleForm adminKey={adminKey} />
    </section>
  );
}
