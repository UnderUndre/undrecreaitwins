import { MatrixAdapter } from './matrix-adapter.js';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const channelId = getArg('channel-id');
const redisUrl = getArg('redis-url');
const tenantId = getArg('tenant-id');
const personaSlug = getArg('persona-slug');
const credentialsJson = getArg('credentials');

if (!channelId || !tenantId || !personaSlug) {
  console.error('Required: --channel-id, --tenant-id, --persona-slug');
  process.exit(1);
}

const credentials = credentialsJson ? JSON.parse(credentialsJson) : {};

const adapter = new MatrixAdapter({
  channelId,
  tenantId,
  personaSlug,
  redisUrl,
  credentials,
});

process.on('SIGINT', async () => {
  await adapter.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await adapter.disconnect();
  process.exit(0);
});

adapter.connect().catch((err) => {
  console.error('Failed to start matrix adapter:', err);
  process.exit(1);
});
