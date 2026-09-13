import { resolveClusterWorkers } from '../../src/config/cluster-workers.ts';

export const CONCURRENT_USERS = Number(process.env.STRESS_USERS ?? 250);
export const CLIENT_SHARDS = Number(process.env.STRESS_CLIENT_SHARDS ?? 4);
export const CLUSTER_WORKERS = resolveClusterWorkers(
  Number(process.env.CLUSTER_WORKERS ?? 4),
);
