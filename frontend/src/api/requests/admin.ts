import type {
  AdminLoginResponse,
  CreateSaleRequest,
  CreateSaleResponse,
} from 'common';
import { request } from '../client.ts';

export function adminLogin(adminKey: string): Promise<AdminLoginResponse> {
  return request<AdminLoginResponse>('/admin/login', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
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
