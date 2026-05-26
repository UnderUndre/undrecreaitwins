import { WhatsAppAdapter } from './whatsapp-adapter.js';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const channelId = getArg('channel-id');
const redisUrl = getArg('redis-url');
const tenantId = getArg('tenant-id');
const personaSlug = getArg('persona-slug');
const evolutionUrl = getArg('evolution-url');
const instanceId = getArg('instance-id');
const webhookSecret = getArg('webhook-secret');

if (!channelId || !tenantId || !personaSlug || !evolutionUrl || !instanceId || !webhookSecret) {
  console.error('Required: --channel-id, --tenant-id, --persona-slug, --evolution-url, --instance-id, --webhook-secret');
  process.exit(1);
}

const adapter = new WhatsAppAdapter({
  channelId,
  tenantId,
  personaSlug,
  evolutionUrl,
  instanceId,
  webhookSecret,
  redisUrl,
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
  console.error('Failed to start whatsapp adapter:', err);
  process.exit(1);
});
