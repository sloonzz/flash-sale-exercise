import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PurchaseResult, SecuredResponse, SecuredStatus } from 'common';
import { ApiError } from '../api/client.ts';
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

const USER_ID_STORAGE_KEY = 'flashSale.userId';
const SECURED_CHECK_DEBOUNCE_MS = 400;
const SLOW_CONFIRMATION_MS = 15_000;

function feedbackForResult(result: PurchaseResult): Feedback | null {
  switch (result) {
    case 'success':
    case 'already_purchased':
      return null;
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
  const activeSale =
    saleStatus && saleStatus.status !== 'no_sale' ? saleStatus : undefined;
  const saleId = activeSale?.id;
  const loading = saleStatusQuery.isPending;
  function getStatusError(): string | null {
    if (!saleStatusQuery.isError) return null;
    return saleStatusQuery.error instanceof ApiError
      ? saleStatusQuery.error.message
      : 'Failed to load sale status';
  }
  const statusError = getStatusError();
  const noSaleConfigured = saleStatus?.status === 'no_sale';

  const remainingStartMs = useCountdown(
    activeSale?.status === 'upcoming' ? activeSale.startTime : undefined,
  );
  const saleHasStarted =
    activeSale?.status === 'upcoming' && remainingStartMs <= 0;
  const effectiveStatus = saleHasStarted ? 'active' : activeSale?.status;
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
  const securedStatus: SecuredStatus | null = isDebouncing
    ? null
    : (securedQuery.data?.status ?? null);

  const [confirmationIsSlow, setConfirmationIsSlow] = useState(false);
  useEffect(() => {
    if (securedStatus !== 'reserved') return;

    const timer = setTimeout(
      () => setConfirmationIsSlow(true),
      SLOW_CONFIRMATION_MS,
    );
    return () => {
      clearTimeout(timer);
      setConfirmationIsSlow(false);
    };
  }, [securedStatus, saleId, debouncedUserId]);

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
            // Optimistically mark the hold; the query's own polling takes it
            // from here to `confirmed` once the Order row exists.
            queryClient.setQueryData<SecuredResponse>(
              securedQueryKey(saleId, trimmedUserId),
              (previous) =>
                previous?.status === 'confirmed'
                  ? previous
                  : { status: 'reserved' },
            );
          }
          saleStatusQuery.refetch();
        },
      },
    );
  }

  const purchasing = purchaseMutation.isPending;
  const holdsItem =
    securedStatus === 'reserved' || securedStatus === 'confirmed';
  const canBuy =
    !loading &&
    !purchasing &&
    !!saleId &&
    effectiveStatus === 'active' &&
    !holdsItem &&
    trimmedUserId.length > 0;

  function buyButtonLabel(): string {
    if (purchasing) return 'Reserving…';
    if (securedStatus === 'reserved') return 'Reserved';
    return 'Buy Now';
  }

  return (
    <section className="panel">
      <h1>Flash Sale</h1>

      {loading && <p>Loading sale…</p>}
      {statusError && !saleStatus && (
        <p className="banner banner-error">{statusError}</p>
      )}
      {noSaleConfigured && (
        <p className="banner banner-warning">No sales available.</p>
      )}

      {activeSale && effectiveStatus && (
        <div className="sale-card">
          <span className={`status-pill status-${effectiveStatus}`}>
            {formatSaleStatus(effectiveStatus)}
          </span>
          <h2>{activeSale.product}</h2>
          {activeSale.status === 'upcoming' && !saleHasStarted && (
            <p className="countdown">
              Starts in {formatCountdown(remainingStartMs)}
            </p>
          )}
          <dl className="sale-times">
            <div>
              <dt>Starts</dt>
              <dd>{formatDateTime(activeSale.startTime)}</dd>
            </div>
            <div>
              <dt>Ends</dt>
              <dd>{formatDateTime(activeSale.endTime)}</dd>
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

        {securedStatus === 'reserved' && (
          <div className="order-progress" role="status" aria-live="polite">
            <ol className="progress-steps">
              <li className="progress-step is-done">
                <span className="progress-mark" aria-hidden="true">
                  ✓
                </span>
                Item reserved
              </li>
              <li className="progress-step is-active">
                <span
                  className="progress-mark progress-spinner"
                  aria-hidden="true"
                />
                Confirming your order…
              </li>
            </ol>
            <p className="progress-hint">
              {confirmationIsSlow
                ? 'This is taking longer than usual. Your reservation is kept — it’s safe to leave and check back.'
                : 'Your item is held for you while we write the order.'}
            </p>
          </div>
        )}

        {securedStatus === 'confirmed' && (
          <p className="banner banner-success">
            {purchaseMutation.data?.result === 'success'
              ? 'Order confirmed: you got one!'
              : "You've already secured an item in this sale."}
          </p>
        )}

        <button
          type="button"
          className="buy-button"
          disabled={!canBuy}
          onClick={handleBuy}
        >
          {buyButtonLabel()}
        </button>

        {feedback && (
          <p className={`banner banner-${feedback.kind}`}>{feedback.message}</p>
        )}
      </div>
    </section>
  );
}
