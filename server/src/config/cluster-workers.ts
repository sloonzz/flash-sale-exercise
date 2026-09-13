import os from 'node:os';

// Forking more cluster workers than the host has cores just adds
// context-switching overhead instead of throughput, so cap at whatever
// the OS actually reports (cgroup-aware where available).
export function resolveClusterWorkers(requested: number): number {
  const availableCores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(requested, availableCores));
}
