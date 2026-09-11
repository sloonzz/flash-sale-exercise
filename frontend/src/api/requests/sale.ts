import type {
  PurchaseResponse,
  SaleStatusResponse,
  SecuredResponse,
} from 'common';
import { request } from '../client.ts';

export function getSaleStatus(
  signal?: AbortSignal,
): Promise<SaleStatusResponse> {
  return request<SaleStatusResponse>('/sale/status', { signal });
}

export function purchase(userId: string): Promise<PurchaseResponse> {
  return request<PurchaseResponse>('/purchase', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export function checkSecured(
  userId: string,
  signal?: AbortSignal,
): Promise<SecuredResponse> {
  return request<SecuredResponse>(`/purchase/${encodeURIComponent(userId)}`, {
    signal,
  });
}
