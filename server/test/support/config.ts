import { resolveClusterWorkers } from '../../src/config/cluster-workers.ts';

export const CONCURRENT_SPIKE_USERS = Number(
  process.env.CONCURRENT_SPIKE_USERS ?? 10000,
);

export const PURCHASE_STRESS_CONNECTIONS = Number(
  process.env.STRESS_PURCHASE_CONNECTIONS ?? 1000,
);
export const PURCHASE_STRESS_DURATION_SECONDS = Number(
  process.env.STRESS_PURCHASE_DURATION ?? 60,
);
export const STATUS_STRESS_CONNECTIONS = Number(
  process.env.STRESS_STATUS_CONNECTIONS ?? 2000,
);
export const STATUS_STRESS_DURATION_SECONDS = Number(
  process.env.STRESS_STATUS_DURATION ?? 60,
);

export const AUTOCANNON_WORKERS = Number(
  process.env.STRESS_AUTOCANNON_WORKERS ?? 4,
);
export const CLUSTER_WORKERS = resolveClusterWorkers(
  Number(process.env.CLUSTER_WORKERS ?? 4),
);

for (const [amount, label] of [
  [CONCURRENT_SPIKE_USERS, 'STRESS_USERS'],
  [PURCHASE_STRESS_CONNECTIONS, 'STRESS_PURCHASE_CONNECTIONS'],
  [STATUS_STRESS_CONNECTIONS, 'STRESS_STATUS_CONNECTIONS'],
] as const) {
  if (amount % AUTOCANNON_WORKERS !== 0) {
    throw new Error(
      `${label} (${amount}) must be evenly divisible by STRESS_AUTOCANNON_WORKERS (${AUTOCANNON_WORKERS}) -- autocannon divides connections/amount evenly across workers, so an uneven split would silently drop requests.`,
    );
  }
}
