import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ParsedMessage } from './telegram-json.js';

function isValidRole(value: unknown): value is 'user' | 'assistant' {
  return value === 'user' || value === 'assistant';
}

export async function* parseGenericJsonl(
  filePath: string,
): AsyncGenerator<ParsedMessage> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!isValidRole(obj.role)) continue;
    if (typeof obj.content !== 'string' || !obj.content.trim()) continue;

    const timestamp = obj.timestamp ?? obj.created_at ?? obj.date;
    yield {
      role: obj.role,
      content: obj.content,
      timestamp: typeof timestamp === 'string'
        ? new Date(timestamp)
        : timestamp instanceof Date
          ? timestamp
          : new Date(),
    };
  }
}
