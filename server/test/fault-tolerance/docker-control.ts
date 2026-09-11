import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Containers are located by the host port they publish, not by a
// docker-compose project name: this suite may run from a git worktree whose
// directory name differs from the checkout that originally ran
// `docker compose up`, which would give it a different (and wrong) compose
// project. The published port is the one thing guaranteed to match what the
// app itself is configured to connect to (see DATABASE_URL/REDIS_URL).
export async function findContainerByPublishedPort(
  port: number,
): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'ps',
    '--filter',
    `publish=${port}`,
    '--format',
    '{{.ID}}',
  ]);
  const id = stdout.trim().split('\n')[0];
  if (!id) {
    throw new Error(`No running container publishes port ${port}`);
  }
  return id;
}

export async function stopContainer(containerId: string): Promise<void> {
  await execFileAsync('docker', ['stop', containerId]);
}

export async function startContainer(containerId: string): Promise<void> {
  await execFileAsync('docker', ['start', containerId]);
}

export async function waitForHealthy(
  containerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format',
      '{{.State.Health.Status}}',
      containerId,
    ]);
    if (stdout.trim() === 'healthy') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Container ${containerId} did not become healthy within ${timeoutMs}ms`,
  );
}

export async function flushRedis(containerId: string): Promise<void> {
  await execFileAsync('docker', ['exec', containerId, 'redis-cli', 'FLUSHALL']);
}

// Assumes the container is attached to exactly one network, true for this
// project's docker-compose setup.
export async function getContainerNetwork(
  containerId: string,
): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'inspect',
    '--format',
    '{{range $net, $v := .NetworkSettings.Networks}}{{$net}}{{end}}',
    containerId,
  ]);
  const network = stdout.trim();
  if (!network) {
    throw new Error(`Container ${containerId} is not attached to a network`);
  }
  return network;
}

export async function disconnectNetwork(
  network: string,
  containerId: string,
): Promise<void> {
  await execFileAsync('docker', [
    'network',
    'disconnect',
    network,
    containerId,
  ]);
}

export async function connectNetwork(
  network: string,
  containerId: string,
): Promise<void> {
  await execFileAsync('docker', ['network', 'connect', network, containerId]);
}
