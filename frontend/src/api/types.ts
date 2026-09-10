// Mirrors server/src/sale/sale-types.ts and sale.schemas.ts. Duplicated here
// (rather than imported) because the frontend and server are separate
// workspaces with no shared package.

export type SaleStatus = 'upcoming' | 'active' | 'soldout' | 'ended';

export interface SaleStatusResponse {
  status: SaleStatus;
  startTime: string;
  endTime: string;
  product: string;
}

export type PurchaseResult =
  'success' | 'already_purchased' | 'sold_out' | 'ended' | 'not_active';

export interface PurchaseResponse {
  result: PurchaseResult;
}

export interface SecuredResponse {
  secured: boolean;
}

export interface CreateSaleInput {
  productName: string;
  totalStock: number;
  startTime: string;
  endTime: string;
}

export interface CreateSaleResponse {
  id: string;
  product: string;
  totalStock: number;
  startTime: string;
  endTime: string;
}
