import { WeComAdapter } from './wecom-adapter.js';

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
const portStr = getArg('port');

if (!channelId || !tenantId || !personaSlug) {
  process.stderr.write('Required: --channel-id, --tenant-id, --persona-slug\n');
  process.exit(1);
}

const credentials = credentialsJson ? JSON.parse(credentialsJson) : {};
const port = portStr ? parseInt(portStr, 10) : undefined;

const adapter = new WeComAdapter({
  channelId,
  tenantId,
  personaSlug,
  redisUrl,
  port,
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
  process.stderr.write(`Failed to start wecom adapter: ${err}\n`);
  process.exit(1);
});
