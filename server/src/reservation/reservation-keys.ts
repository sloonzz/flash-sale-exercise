export function stockKey(saleId: string): string {
  return `reservation:${saleId}:stock`;
}

export function reservedUsersKey(saleId: string): string {
  return `reservation:${saleId}:reserved-users`;
}
