import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PurchaseResult } from 'common';
import { ApiError, checkSecured, purchase } from '../api/client.ts';
import { useSaleStatus } from '../hooks/useSaleStatus.ts';
import { formatDateTime, formatSaleStatus } from '../lib/format.ts';

const USER_ID_STORAGE_KEY = 'flashSale.userId';
const SECURED_CHECK_DEBOUNCE_MS = 400;

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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export function BuyerPage() {
  const queryClient = useQueryClient();
  const { saleStatus, loading, error: statusError, refresh } = useSaleStatus();
  const [userId, setUserId] = useState(
    () => localStorage.getItem(USER_ID_STORAGE_KEY) ?? '',
  );
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  }, [userId]);

  const trimmedUserId = userId.trim();
  const debouncedUserId = useDebouncedValue(
    trimmedUserId,
    SECURED_CHECK_DEBOUNCE_MS,
  );
  const isDebouncing = trimmedUserId !== debouncedUserId;

  const securedQuery = useQuery({
    queryKey: ['secured', debouncedUserId],
    queryFn: ({ signal }) => checkSecured(debouncedUserId, signal),
    enabled: debouncedUserId.length > 0,
  });
  const secured = isDebouncing ? null : (securedQuery.data?.secured ?? null);

  const purchaseMutation = useMutation({
    mutationFn: (userId: string) => purchase(userId),
  });

  async function handleBuy() {
    if (!trimmedUserId) return;

    setFeedback(null);
    try {
      const { result } = await purchaseMutation.mutateAsync(trimmedUserId);
      setFeedback(feedbackForResult(result));
      if (result === 'success' || result === 'already_purchased') {
        queryClient.setQueryData(['secured', trimmedUserId], {
          secured: true,
        });
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
    }
  }

  const purchasing = purchaseMutation.isPending;
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
            setUserId(event.target.value);
            setFeedback(null);
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
