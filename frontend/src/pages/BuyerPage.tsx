import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PurchaseResult } from 'common';
import { ApiError } from '../api/client.ts';
import { errorMessage } from '../api/errors.ts';
import { getMutationFeedback, type Feedback } from '../api/feedback.ts';
import { useSaleStatusQuery } from '../api/queries/useSaleStatusQuery.ts';
import {
  securedQueryKey,
  useSecuredQuery,
} from '../api/queries/useSecuredQuery.ts';
import { usePurchaseMutation } from '../api/mutations/usePurchaseMutation.ts';
import {
  formatCountdown,
  formatDateTime,
  formatSaleStatus,
} from '../lib/format.ts';

const STATUS_ERROR_OVERRIDES = { 404: 'No sales available.' };

const USER_ID_STORAGE_KEY = 'flashSale.userId';
const SECURED_CHECK_DEBOUNCE_MS = 400;

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
    case 'invalid_sale':
      return {
        kind: 'warning',
        message: 'Invalid sale.',
      };
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

/** Milliseconds remaining until targetIso, ticking down to 0 with no target. */
function useCountdown(targetIso: string | undefined): number {
  const targetMs = targetIso ? new Date(targetIso).getTime() : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (targetMs === null || targetMs <= Date.now()) return;

    const interval = setInterval(() => {
      const nowMs = Date.now();
      setNow(nowMs);
      if (targetMs <= nowMs) clearInterval(interval);
    }, 250);

    return () => clearInterval(interval);
  }, [targetMs]);

  return targetMs === null ? 0 : Math.max(0, targetMs - now);
}

export function BuyerPage() {
  const queryClient = useQueryClient();
  const saleStatusQuery = useSaleStatusQuery();
  const saleStatus = saleStatusQuery.data;
  const saleId = saleStatus?.id;
  const loading = saleStatusQuery.isPending;
  function getStatusError(): string | null {
    if (!saleStatusQuery.isError) return null;
    return saleStatusQuery.error instanceof ApiError
      ? errorMessage(saleStatusQuery.error, STATUS_ERROR_OVERRIDES)
      : 'Failed to load sale status';
  }
  const statusError = getStatusError();

  const remainingStartMs = useCountdown(
    saleStatus?.status === 'upcoming' ? saleStatus.startTime : undefined,
  );
  const saleHasStarted =
    saleStatus?.status === 'upcoming' && remainingStartMs <= 0;
  const effectiveStatus = saleHasStarted ? 'active' : saleStatus?.status;
  const [userId, setUserId] = useState(
    () => localStorage.getItem(USER_ID_STORAGE_KEY) ?? '',
  );

  useEffect(() => {
    localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  }, [userId]);

  const trimmedUserId = userId.trim();
  const debouncedUserId = useDebouncedValue(
    trimmedUserId,
    SECURED_CHECK_DEBOUNCE_MS,
  );
  const isDebouncing = trimmedUserId !== debouncedUserId;

  const securedQuery = useSecuredQuery(saleId, debouncedUserId);
  const secured = isDebouncing ? null : (securedQuery.data?.secured ?? null);

  const purchaseMutation = usePurchaseMutation();

  const { reset: resetPurchaseMutation } = purchaseMutation;
  useEffect(() => {
    resetPurchaseMutation();
  }, [saleId, resetPurchaseMutation]);

  const feedback = getMutationFeedback(purchaseMutation, {
    onSuccess: (data) => feedbackForResult(data.result),
    errorOverrides: {
      429: 'Too many attempts — please slow down and try again.',
    },
  });

  function handleBuy() {
    if (!trimmedUserId || !saleId) return;

    purchaseMutation.mutate(
      { userId: trimmedUserId, saleId },
      {
        onSuccess: ({ result }) => {
          if (result === 'success' || result === 'already_purchased') {
            queryClient.setQueryData(securedQueryKey(saleId, trimmedUserId), {
              secured: true,
            });
          }
          saleStatusQuery.refetch();
        },
      },
    );
  }

  const purchasing = purchaseMutation.isPending;
  const canBuy =
    !loading &&
    !purchasing &&
    !!saleId &&
    effectiveStatus === 'active' &&
    secured !== true &&
    trimmedUserId.length > 0;

  return (
    <section className="panel">
      <h1>Flash Sale</h1>

      {loading && <p>Loading sale…</p>}
      {statusError && !saleStatus && (
        <p className="banner banner-error">{statusError}</p>
      )}

      {saleStatus && effectiveStatus && (
        <div className="sale-card">
          <span className={`status-pill status-${effectiveStatus}`}>
            {formatSaleStatus(effectiveStatus)}
          </span>
          <h2>{saleStatus.product}</h2>
          {saleStatus.status === 'upcoming' && !saleHasStarted && (
            <p className="countdown">
              Starts in {formatCountdown(remainingStartMs)}
            </p>
          )}
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
            purchaseMutation.reset();
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
