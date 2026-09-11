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

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
