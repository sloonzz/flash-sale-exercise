import { resolveClusterWorkers } from '../../src/config/cluster-workers.ts';

export interface LoadProfile {
  /** Spike = short burst of many connections; stress = fewer connections sustained for longer. */
  name: 'spike' | 'stress';
  connections: number;
  durationSeconds: number;
}

export const SPIKE_CONNECTIONS = Number(process.env.SPIKE_CONNECTIONS ?? 1000);
export const SPIKE_DURATION = Number(process.env.SPIKE_DURATION ?? 15);
export const STRESS_CONNECTIONS = Number(process.env.STRESS_CONNECTIONS ?? 100);
export const STRESS_DURATION = Number(process.env.STRESS_DURATION ?? 60);

export const AUTOCANNON_WORKERS = Number(process.env.AUTOCANNON_WORKERS ?? 5);

export const SETTLE_GRACE_MS = Number(process.env.SETTLE_GRACE_MS ?? 30_000);
export const SETTLE_ORDERS_PER_SECOND = Number(
  process.env.SETTLE_ORDERS_PER_SECOND ?? 1_000,
);
export const CLUSTER_WORKERS = resolveClusterWorkers(
  Number(process.env.CLUSTER_WORKERS ?? 4),
);

export const LOAD_PROFILES: LoadProfile[] = [
  {
    name: 'spike',
    connections: SPIKE_CONNECTIONS,
    durationSeconds: SPIKE_DURATION,
  },
  {
    name: 'stress',
    connections: STRESS_CONNECTIONS,
    durationSeconds: STRESS_DURATION,
  },
];

for (const [amount, label] of [
  [SPIKE_CONNECTIONS, 'SPIKE_CONNECTIONS'],
  [STRESS_CONNECTIONS, 'STRESS_CONNECTIONS'],
] as const) {
  if (amount % AUTOCANNON_WORKERS !== 0) {
    throw new Error(
      `${label} (${amount}) must be evenly divisible by AUTOCANNON_WORKERS (${AUTOCANNON_WORKERS}) -- autocannon divides connections/amount evenly across workers, so an uneven split would silently drop requests.`,
    );
  }
}
