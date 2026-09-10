import type {
  CreateSaleRequest,
  CreateSaleResponse,
  PurchaseResponse,
  SaleStatusResponse,
  SecuredResponse,
} from 'common';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Could not reach the server', 0);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const bodyMessage =
      body && typeof body === 'object' && 'message' in body
        ? (body as { message: unknown }).message
        : null;
    const message =
      typeof bodyMessage === 'string' && bodyMessage.length > 0
        ? bodyMessage
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return response.json() as Promise<T>;
}

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

export function createSale(
  input: CreateSaleRequest,
  adminKey: string,
): Promise<CreateSaleResponse> {
  return request<CreateSaleResponse>('/admin/sales', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
    body: JSON.stringify(input),
  });
}
