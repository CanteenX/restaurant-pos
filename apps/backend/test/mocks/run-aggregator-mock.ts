// Start the mock partner:  pnpm --filter ./apps/backend mock:aggregator
// Env: MOCK_API_KEY, MOCK_WEBHOOK_SECRET (16+ chars), MOCK_PORT (default 4010).
import { AggregatorMock } from './aggregator-mock';

const mock = new AggregatorMock({
  apiKey: process.env.MOCK_API_KEY ?? 'mock_api_key',
  webhookSecret: process.env.MOCK_WEBHOOK_SECRET ?? 'mock_webhook_secret_123',
  port: Number(process.env.MOCK_PORT ?? 4010),
});
void mock.start().then((url) => {
  process.stdout.write(`Aggregator mock listening on ${url}\n`);
});
process.on('SIGINT', () => void mock.stop().then(() => process.exit(0)));
