export const PERSIST_ORDER_QUEUE = 'persist-order';

export interface PersistOrderJobData {
  saleId: string;
  userId: string;
  timestamp: string;
}
