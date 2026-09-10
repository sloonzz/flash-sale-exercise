import { useEffect, useState } from 'react';
import { ApiError, checkSecured, purchase } from '../api/client.ts';
import type { PurchaseResult } from '../api/types.ts';
import { useSaleStatus } from '../hooks/useSaleStatus.ts';
import { formatDateTime, formatSaleStatus } from '../lib/format.ts';

const USER_ID_STORAGE_KEY = 'flashSale.userId';

interface Feedback {
  kind: 'success' | 'warning' | 'error';
  message: string;
}

function feedbackForResult(result: PurchaseResult): Feedback {
  switch (result) {
    case 'success':
      return { kind: 'success', message: 'Purchase confirmed — you got one!' };
    case 'already_purchased':
      return {
        kind: 'warning',
        message: "You've already secured an item in this sale.",
      };
    case 'sold_out':
      return { kind: 'warning', message: 'Sold out — no stock left.' };
    case 'ended':
      return { kind: 'warning', message: 'This sale has ended.' };
    case 'not_active':
      return { kind: 'warning', message: "This sale isn't active yet." };
  }
}

export function BuyerPage() {
  const { saleStatus, loading, error: statusError, refresh } = useSaleStatus();
  const [userId, setUserId] = useState(
    () => localStorage.getItem(USER_ID_STORAGE_KEY) ?? '',
  );
  const [secured, setSecured] = useState<boolean | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  }, [userId]);

  const trimmedUserId = userId.trim();

  useEffect(() => {
    if (!trimmedUserId) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { secured: isSecured } = await checkSecured(
          trimmedUserId,
          controller.signal,
        );
        setSecured(isSecured);
      } catch {
        // Best-effort check; the buy attempt itself is the source of truth.
      }
    }, 400);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmedUserId]);

  async function handleBuy() {
    if (!trimmedUserId) return;

    setPurchasing(true);
    setFeedback(null);
    try {
      const { result } = await purchase(trimmedUserId);
      setFeedback(feedbackForResult(result));
      if (result === 'success' || result === 'already_purchased') {
        setSecured(true);
      }
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setFeedback({
          kind: 'error',
          message: 'Too many attempts — please slow down and try again.',
        });
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
      setPurchasing(false);
    }
  }

  const canBuy =
    !loading &&
    !purchasing &&
    saleStatus?.status === 'active' &&
    secured !== true &&
    trimmedUserId.length > 0;

  return (
    <section className="panel">
      <h1>Flash Sale</h1>

      {loading && <p>Loading sale…</p>}
      {statusError && !saleStatus && (
        <p className="banner banner-error">{statusError}</p>
      )}

      {saleStatus && (
        <div className="sale-card">
          <span className={`status-pill status-${saleStatus.status}`}>
            {formatSaleStatus(saleStatus.status)}
          </span>
          <h2>{saleStatus.product}</h2>
          <dl className="sale-times">
            <div>
              <dt>Starts</dt>
              <dd>{formatDateTime(saleStatus.startTime)}</dd>
            </div>
            <div>
              <dt>Ends</dt>
              <dd>{formatDateTime(saleStatus.endTime)}</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="buy-form">
        <label htmlFor="userId">Your email or username</label>
        <input
          id="userId"
          type="text"
          value={userId}
          onChange={(event) => {
            const value = event.target.value;
            setUserId(value);
            setFeedback(null);
            if (!value.trim()) {
              setSecured(null);
            }
          }}
          placeholder="you@example.com"
          autoComplete="username"
        />

        {secured === true && !feedback && (
          <p className="banner banner-warning">
            You've already secured an item in this sale.
          </p>
        )}

        <button
          type="button"
          className="buy-button"
          disabled={!canBuy}
          onClick={handleBuy}
        >
          {purchasing ? 'Buying…' : 'Buy Now'}
        </button>

        {feedback && (
          <p className={`banner banner-${feedback.kind}`}>{feedback.message}</p>
        )}
      </div>
    </section>
  );
}
