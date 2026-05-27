#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { resolve as pathResolve } from 'path';
import { personaCommand } from './commands/persona.js';
import { conversationCommand } from './commands/conversation.js';
import { trainCommand } from './commands/train.js';
import { channelCommand } from './commands/channel.js';
import { healthCommand } from './commands/health.js';

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function getSubcommand(args: string[]): { command: string; rest: string[] } {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      i++;
      continue;
    }
    positional.push(args[i]!);
  }
  return { command: positional[0] ?? '', rest: positional.slice(1) };
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  const tenantId = getFlag(args, '--tenant-id');
  const apiUrl = getFlag(args, '--api-url') || process.env.TWIN_API_URL || 'http://localhost:8090';
  const output = getFlag(args, '--output') || 'table';

  const { command, rest } = getSubcommand(args);

  if (!tenantId && command !== 'health') {
    console.error('Required: --tenant-id');
    process.exit(1);
  }

  const ctx = {
    apiUrl,
    tenantId: tenantId ?? '',
    output,
  };

  switch (command) {
    case 'persona':
      await personaCommand(ctx, rest);
      break;
    case 'conversation':
      await conversationCommand(ctx, rest);
      break;
    case 'train':
      await trainCommand(ctx, rest);
      break;
    case 'channel':
      await channelCommand(ctx, rest);
      break;
    case 'health':
      await healthCommand(ctx);
      break;
    default:
      console.log('Usage: twin [--tenant-id <id>] [--api-url <url>] [--output json|table] <command> [subcommand]');
      console.log('Commands: persona, conversation, train, channel, health');
      process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && pathResolve(process.argv[1]) === __filename) {
  main(process.argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { getFlag, getSubcommand, main };
