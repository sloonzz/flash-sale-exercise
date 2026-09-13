import autocannon from 'autocannon';

interface ClientConfig {
  url: string;
  amount: number;
  saleId: string;
  userIds: 'unique' | 'duplicate';
  userIdOffset?: number;
}

const config: ClientConfig = JSON.parse(process.argv[2]);
const results: Array<string | null> = [];
let requestIndex = config.userIdOffset ?? 0;

function nextUserId(): string {
  if (config.userIds === 'duplicate') {
    return 'stress-user-duplicate';
  }
  return `stress-user-${requestIndex++}`;
}

const runResult = await autocannon({
  url: config.url,
  connections: config.amount,
  amount: config.amount,
  timeout: 30,
  requests: [
    {
      method: 'POST',
      setupRequest: (req) => ({
        ...req,
        path: '/purchase',
        headers: { ...req.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: nextUserId(),
          saleId: config.saleId,
        }),
      }),
      onResponse: (status, body) => {
        results.push(status === 201 ? JSON.parse(body).result : null);
      },
    },
  ],
});

process.stdout.write(JSON.stringify({ results, runResult }));
