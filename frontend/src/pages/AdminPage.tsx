import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, createSale } from '../api/client.ts';
import type { CreateSaleResponse } from '../api/types.ts';

const ADMIN_KEY_STORAGE_KEY = 'flashSale.adminKey';

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

export function AdminPage() {
  const [adminKey, setAdminKey] = useState(
    () => sessionStorage.getItem(ADMIN_KEY_STORAGE_KEY) ?? '',
  );
  const [keyInput, setKeyInput] = useState('');
  const [productName, setProductName] = useState('');
  const [totalStock, setTotalStock] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [created, setCreated] = useState<CreateSaleResponse | null>(null);

  function unlock(event: FormEvent) {
    event.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    sessionStorage.setItem(ADMIN_KEY_STORAGE_KEY, trimmed);
    setAdminKey(trimmed);
  }

  function lock() {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    setAdminKey('');
    setKeyInput('');
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFeedback(null);
    setSubmitting(true);
    try {
      const sale = await createSale(
        {
          productName,
          totalStock: Number(totalStock),
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
        },
        adminKey,
      );
      setCreated(sale);
      setFeedback({ kind: 'success', message: 'Sale saved.' });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        setFeedback({ kind: 'error', message: 'Invalid admin key.' });
        lock();
      } else {
        setFeedback({
          kind: 'error',
          message:
            err instanceof ApiError
              ? err.message
              : 'Something went wrong. Please try again.',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!adminKey) {
    return (
      <section className="panel">
        <h1>Admin</h1>
        <form className="admin-gate" onSubmit={unlock}>
          <label htmlFor="adminKey">Admin key</label>
          <input
            id="adminKey"
            type="password"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            autoComplete="off"
          />
          <button type="submit" disabled={!keyInput.trim()}>
            Unlock
          </button>
        </form>
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

      <form className="admin-form" onSubmit={handleSubmit}>
        <label htmlFor="productName">Product name</label>
        <input
          id="productName"
          type="text"
          value={productName}
          onChange={(event) => setProductName(event.target.value)}
          required
        />

        <label htmlFor="totalStock">Stock</label>
        <input
          id="totalStock"
          type="number"
          min={0}
          step={1}
          value={totalStock}
          onChange={(event) => setTotalStock(event.target.value)}
          required
        />

        <label htmlFor="startTime">Start time</label>
        <input
          id="startTime"
          type="datetime-local"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
          required
        />

        <label htmlFor="endTime">End time</label>
        <input
          id="endTime"
          type="datetime-local"
          value={endTime}
          onChange={(event) => setEndTime(event.target.value)}
          required
        />

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save sale'}
        </button>

        {feedback && (
          <p className={`banner banner-${feedback.kind}`}>{feedback.message}</p>
        )}

        {created && (
          <p className="admin-created">
            Saved <strong>{created.product}</strong> — {created.totalStock}{' '}
            units.
          </p>
        )}
      </form>
    </section>
  );
}
