import { useCallback, useEffect, useState } from 'react';
import { ApiError, getSaleStatus } from '../api/client.ts';
import type { SaleStatusResponse } from '../api/types.ts';

const POLL_INTERVAL_MS = 4000;

interface UseSaleStatusResult {
  saleStatus: SaleStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSaleStatus(): UseSaleStatusResult {
  const [saleStatus, setSaleStatus] = useState<SaleStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const refresh = useCallback(() => {
    setRefreshSignal((tick) => tick + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const status = await getSaleStatus(controller.signal);
        if (!cancelled) {
          setSaleStatus(status);
          setError(null);
        }
      } catch (err) {
        if (
          !cancelled &&
          !(err instanceof DOMException && err.name === 'AbortError')
        ) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load sale status',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }

    poll();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [refreshSignal]);

  return { saleStatus, loading, error, refresh };
}
