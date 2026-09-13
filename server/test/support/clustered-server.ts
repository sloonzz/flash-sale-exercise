import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(
  new URL('../../src/main.ts', import.meta.url),
);

interface ReadyMessage {
  ready?: boolean;
  port?: number;
}

export interface ClusteredServer {
  baseUrl: string;
  stop: () => void;
}

// Runs the actual server entry (src/main.ts) as a real, separate OS process,
// clustered via CLUSTER_WORKERS -- instead of Nest's in-process TestingModule.
// This is the only way to exercise cluster.fork() for real, and it matches
// how the service actually runs in production.
// @swc-node/register (not tsx) transpiles it: esbuild-based loaders silently
// drop the decorator metadata Nest's type-based DI relies on.
export async function startClusteredServer(
  env: Record<string, string>,
): Promise<ClusteredServer> {
  const serverProcess: ChildProcess = fork(SERVER_ENTRY, [], {
    execArgv: ['--import', '@swc-node/register/esm-register'],
    env: { ...process.env, PORT: '0', DISABLE_NEST_LOGS: 'true', ...env },
  });

  const port = await new Promise<number>((resolve, reject) => {
    serverProcess.on('message', (message: ReadyMessage) => {
      if (message.ready && message.port) resolve(message.port);
    });
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`server process exited with code ${code}`));
      }
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => serverProcess.kill('SIGTERM'),
  };
}
