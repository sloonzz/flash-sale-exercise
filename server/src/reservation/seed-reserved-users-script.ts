// KEYS[1] = reserved-users key, ARGV = user ids to seed.
// Atomically checked-and-set so reconciliation never clobbers a key that's
// already live (e.g. Postgres's Order count lagging Redis's own state).
// Adds members one at a time rather than via unpack(ARGV), since a large
// sale's user list can exceed Lua's unpack/stack limit (~8000 elements).
export const SEED_RESERVED_USERS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end

for i = 1, #ARGV do
  redis.call('SADD', KEYS[1], ARGV[i])
end

return 1
`;
