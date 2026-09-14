// KEYS[1] = stock key, KEYS[2] = reserved-users key, KEYS[3] = order outbox stream
// ARGV[1] = userId, ARGV[2] = saleId, ARGV[3] = reservation timestamp (ISO)
// IMPORTANT: Always sync with ReservationResult type and parseOrderOutboxEntry
//
// The XADD is the transactional outbox: the Reservation and the record that an
// Order must be persisted for it are written in the same atomic script, so a
// crash after the reservation can never leave it without a pending Order.
export const RESERVE_SCRIPT = `
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return 'already_purchased'
end

local stock = tonumber(redis.call('GET', KEYS[1]))
if not stock or stock <= 0 then
  return 'sold_out'
end

redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('XADD', KEYS[3], '*', 'saleId', ARGV[2], 'userId', ARGV[1], 'timestamp', ARGV[3])
return 'success'
`;
