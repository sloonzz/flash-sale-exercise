// KEYS[1] = order outbox stream
// ARGV[1] = consumer group, ARGV[2] = min idle ms, ARGV[3] = consumer name to keep
//
// Removes every consumer in the group that holds no pending entries and has
// been idle for at least ARGV[2] ms. Consumers are named after the process
// that created them, so each crashed or killed drainer leaves one behind.
//
// Atomic on purpose: checking XINFO and deleting in two round-trips would
// leave a window in which the consumer is delivered an entry and then
// deleted with it — and DELCONSUMER discards the consumer's pending entries.
// Deleting a live consumer is harmless: its next XREADGROUP recreates it.
export const PRUNE_OUTBOX_CONSUMERS_SCRIPT = `
local removed = 0
for _, consumer in ipairs(redis.call('XINFO', 'CONSUMERS', KEYS[1], ARGV[1])) do
  local info = {}
  for i = 1, #consumer, 2 do
    info[consumer[i]] = consumer[i + 1]
  end
  if info.name ~= ARGV[3] and info.pending == 0 and info.idle >= tonumber(ARGV[2]) then
    redis.call('XGROUP', 'DELCONSUMER', KEYS[1], ARGV[1], info.name)
    removed = removed + 1
  end
end
return removed
`;
