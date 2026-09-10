import { useState } from 'react';
import { AdminGateForm } from '../components/AdminGateForm.tsx';
import { AdminSaleForm } from '../components/AdminSaleForm.tsx';

const ADMIN_KEY_STORAGE_KEY = 'flashSale.adminKey';

export function AdminPage() {
  const [adminKey, setAdminKey] = useState(
    () => localStorage.getItem(ADMIN_KEY_STORAGE_KEY) ?? '',
  );

  function unlock(key: string) {
    localStorage.setItem(ADMIN_KEY_STORAGE_KEY, key);
    setAdminKey(key);
  }

  function lock() {
    localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    setAdminKey('');
  }

  if (!adminKey) {
    return (
      <section className="panel">
        <h1>Admin</h1>
        <AdminGateForm onUnlock={unlock} />
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="admin-header">
        <h1>Admin</h1>
        <button type="button" className="link-button" onClick={lock}>
          Lock
        </button>
      </div>

      <AdminSaleForm adminKey={adminKey} onInvalidKey={lock} />
    </section>
  );
}
