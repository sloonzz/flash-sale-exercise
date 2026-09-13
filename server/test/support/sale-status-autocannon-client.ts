import autocannon from 'autocannon';

interface ClientConfig {
  url: string;
  amount: number;
}

const config: ClientConfig = JSON.parse(process.argv[2]);
const statuses: number[] = [];

const runResult = await autocannon({
  url: config.url,
  connections: config.amount,
  amount: config.amount,
  requests: [
    {
      method: 'GET',
      path: '/sale/status',
      onResponse: (status) => {
        statuses.push(status);
      },
    },
  ],
});

process.stdout.write(JSON.stringify({ statuses, runResult }));
