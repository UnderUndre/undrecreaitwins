import { TelegramAdapter } from './telegram-adapter.js';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const channelId = getArg('channel-id');
const redisUrl = getArg('redis-url');
const botToken = getArg('bot-token');
const tenantId = getArg('tenant-id');
const personaSlug = getArg('persona-slug');

if (!channelId || !botToken || !tenantId || !personaSlug) {
  console.error('Required: --channel-id, --bot-token, --tenant-id, --persona-slug');
  process.exit(1);
}

const adapter = new TelegramAdapter({
  botToken,
  channelId,
  tenantId,
  personaSlug,
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
  console.error('Failed to start telegram adapter:', err);
  process.exit(1);
});
