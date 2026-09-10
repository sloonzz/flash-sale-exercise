import type { SaleStatus } from 'common';

const STATUS_LABELS: Record<SaleStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Active',
  soldout: 'Sold out',
  ended: 'Ended',
};

export function formatSaleStatus(status: SaleStatus): string {
  return STATUS_LABELS[status];
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
