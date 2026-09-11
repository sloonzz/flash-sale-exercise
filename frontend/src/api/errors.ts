import { ApiError } from './client.ts';

export function errorMessage(
  error: ApiError,
  overrides?: Partial<Record<number, string>>,
): string {
  return overrides?.[error.status] ?? error.message;
}
