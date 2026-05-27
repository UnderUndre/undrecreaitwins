import { readFile } from 'node:fs/promises';
import type { TrainingSourceType } from '@undrecreaitwins/shared';

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface TelegramParseOptions {
  assistantIdentifiers?: string[];
  sourceType?: TrainingSourceType;
}

const DEFAULT_ASSISTANT_IDENTIFIERS = new Set([
  'assistant',
  'bot',
  'ai',
  'gpt',
  'claude',
  'chatgpt',
]);

function extractTextParts(parts: unknown[]): string {
  let result = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      result += part;
    } else if (part && typeof part === 'object') {
      const obj = part as Record<string, unknown>;
      if (typeof obj.text === 'string') {
        result += obj.text;
      }
    }
  }
  return result;
}

function resolveRole(
  msg: Record<string, unknown>,
  assistantIds: Set<string>,
): 'user' | 'assistant' {
  const from = typeof msg.from === 'string' ? msg.from.toLowerCase() : '';
  if (assistantIds.has(from)) return 'assistant';

  const fromId = msg.from_id as Record<string, unknown> | undefined;
  if (fromId && typeof fromId === 'object' && 'user_id' in fromId) {
    return 'user';
  }

  return 'user';
}

export async function* parseTelegramJson(
  filePath: string,
  options?: TelegramParseOptions,
): AsyncGenerator<ParsedMessage> {
  const assistantIds = options?.assistantIdentifiers
    ? new Set(options.assistantIdentifiers.map((id) => id.toLowerCase()))
    : DEFAULT_ASSISTANT_IDENTIFIERS;

  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  const messages = data.messages;

  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const record = msg as Record<string, unknown>;
    if (record.type !== 'message') continue;

    const text = record.text;
    if (text == null) continue;

    const content = typeof text === 'string'
      ? text
      : Array.isArray(text)
        ? extractTextParts(text)
        : '';

    if (!content.trim()) continue;

    const dateStr = record.date;
    const timestamp = typeof dateStr === 'string'
      ? new Date(dateStr)
      : new Date();

    yield {
      role: resolveRole(record, assistantIds),
      content,
      timestamp,
    };
  }
}
