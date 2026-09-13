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

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = (
    [
      [days, 'd'],
      [hours, 'h'],
      [minutes, 'm'],
      [seconds, 's'],
    ] as const
  )
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value}${unit}`);

  return parts.length > 0 ? parts.join(' ') : '0s';
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
