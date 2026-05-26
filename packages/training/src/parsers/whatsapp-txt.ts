import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ParsedMessage } from './telegram-json.js';

const WHATSAPP_LINE_REGEX =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*-\s*([^:]+):\s([\s\S]*)$/;

const TIME_REGEX = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i;

function parseWhatsappDate(dateStr: string, timeStr: string): Date {
  const parts = dateStr.split('/').map(Number);
  const month = parts[0] ?? 1;
  const day = parts[1] ?? 1;
  const year = parts[2] ?? 2000;
  const fullYear = year < 100 ? 2000 + year : year;

  const timeMatch = TIME_REGEX.exec(timeStr);
  if (!timeMatch) return new Date(fullYear, month - 1, day);

  let hours = parseInt(timeMatch[1]!, 10);
  const minutes = parseInt(timeMatch[2]!, 10);
  const seconds = timeMatch[3] ? parseInt(timeMatch[3]!, 10) : 0;
  const ampm = timeMatch[4]?.toUpperCase();

  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;

  return new Date(fullYear, month - 1, day, hours, minutes, seconds);
}

export async function* parseWhatsappTxt(
  filePath: string,
): AsyncGenerator<ParsedMessage> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let pendingContent = '';
  let pendingTimestamp: Date | null = null;

  for await (const line of rl) {
    const match = WHATSAPP_LINE_REGEX.exec(line);

    if (match) {
      if (pendingTimestamp && pendingContent.trim()) {
        yield {
          role: 'user',
          content: pendingContent.trim(),
          timestamp: pendingTimestamp,
        };
      }

      const dateStr = match[1]!;
      const timeStr = match[2]!;
      const content = match[4]!;

      pendingTimestamp = parseWhatsappDate(dateStr, timeStr);
      pendingContent = content;
    } else {
      pendingContent += '\n' + line;
    }
  }

  if (pendingTimestamp && pendingContent.trim()) {
    yield {
      role: 'user',
      content: pendingContent.trim(),
      timestamp: pendingTimestamp,
    };
  }
}
