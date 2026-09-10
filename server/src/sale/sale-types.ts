import type { ReservationResult } from '../reservation/reservation.service.ts';
import type { CreateSaleBody } from './sale.schemas.ts';

export type SaleStatus = 'upcoming' | 'active' | 'soldout' | 'ended';

export interface SaleStatusResponse {
  status: SaleStatus;
  startTime: string;
  endTime: string;
  product: string;
}

export type PurchaseResult = ReservationResult | 'ended' | 'not_active';

export type CreateSaleInput = CreateSaleBody;
