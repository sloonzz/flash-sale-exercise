import os from 'node:os';

export function resolveClusterWorkers(requested: number): number {
  const availableCores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(requested, availableCores));
}
