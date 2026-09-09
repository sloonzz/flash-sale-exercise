// KEYS[1] = stock key, KEYS[2] = reserved-users key, ARGV[1] = userId.
// One-per-user is enforced independent of stock (see CONTEXT.md's Reservation
// definition), so the already-purchased check runs before the stock check.
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
return 'success'
`;
