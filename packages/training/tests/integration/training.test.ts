import { describe, it, expect, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTelegramJson } from '../../src/parsers/telegram-json.js';
import { parseGenericJsonl } from '../../src/parsers/generic-jsonl.js';
import { extractTraits } from '../../src/extractors/trait-extractor.js';

const TMP = join(tmpdir(), `twin-training-test-${Date.now()}`);

async function writeTmp(name: string, content: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const p = join(TMP, name);
  await writeFile(p, content, 'utf-8');
  return p;
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe('parseTelegramJson', () => {
  it('extracts messages from valid Telegram export', async () => {
    const telegramExport = {
      messages: [
        { type: 'message', date: '2025-01-01T10:00:00', from: 'Alice', from_id: { user_id: 1 }, text: 'Hello there' },
        { type: 'message', date: '2025-01-01T10:01:00', from: 'Bob', from_id: { user_id: 2 }, text: 'How are you doing today?' },
        { type: 'message', date: '2025-01-01T10:02:00', from: 'Alice', from_id: { user_id: 1 }, text: 'Great thanks! Working on the project.' },
        { type: 'message', date: '2025-01-01T10:03:00', from: 'Bob', from_id: { user_id: 2 }, text: 'That sounds wonderful' },
        { type: 'service', date: '2025-01-01T10:04:00', text: 'Channel created' },
      ],
    };

    const filePath = await writeTmp('telegram.json', JSON.stringify(telegramExport));
    const messages = [];
    for await (const msg of parseTelegramJson(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(4);
    expect(messages[0]!.content).toBe('Hello there');
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.content).toBe('How are you doing today?');
  });

  it('handles text as array of parts', async () => {
    const telegramExport = {
      messages: [
        { type: 'message', date: '2025-01-01T10:00:00', from: 'Alice', text: ['Hello ', { text: 'world' }] },
      ],
    };

    const filePath = await writeTmp('telegram_parts.json', JSON.stringify(telegramExport));
    const messages = [];
    for await (const msg of parseTelegramJson(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Hello world');
  });

  it('returns empty for file with no messages array', async () => {
    const filePath = await writeTmp('empty_telegram.json', JSON.stringify({ name: 'test' }));
    const messages = [];
    for await (const msg of parseTelegramJson(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(0);
  });
});

describe('parseGenericJsonl', () => {
  it('parses valid JSONL lines', async () => {
    const lines = [
      JSON.stringify({ role: 'user', content: 'Hello', timestamp: '2025-01-01T10:00:00Z' }),
      JSON.stringify({ role: 'assistant', content: 'Hi there!', timestamp: '2025-01-01T10:00:05Z' }),
      '',
      JSON.stringify({ role: 'user', content: 'How are you?' }),
    ];

    const filePath = await writeTmp('messages.jsonl', lines.join('\n'));
    const messages = [];
    for await (const msg of parseGenericJsonl(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Hello');
    expect(messages[1]!.role).toBe('assistant');
  });

  it('skips lines with invalid JSON', async () => {
    const lines = [
      'not valid json',
      JSON.stringify({ role: 'user', content: 'Valid message' }),
      '{ broken',
    ];

    const filePath = await writeTmp('mixed.jsonl', lines.join('\n'));
    const messages = [];
    for await (const msg of parseGenericJsonl(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Valid message');
  });

  it('skips lines with invalid roles', async () => {
    const lines = [
      JSON.stringify({ role: 'system', content: 'System prompt' }),
      JSON.stringify({ role: 'user', content: 'User message' }),
      JSON.stringify({ role: 'invalid', content: 'Bad role' }),
    ];

    const filePath = await writeTmp('roles.jsonl', lines.join('\n'));
    const messages = [];
    for await (const msg of parseGenericJsonl(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });
});

describe('extractTraits', () => {
  it('populates at least 5 trait fields from sufficient messages', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `This is message number ${i + 1}. I think the weather is great today. However, we should consider the implications carefully.`,
      timestamp: new Date(`2025-01-01T10:${String(i).padStart(2, '0')}:00Z`),
    }));

    const traits = extractTraits(messages);

    const populatedFields = Object.entries(traits).filter(
      ([key, val]) => key !== 'manual_lock' && val !== undefined && val !== null,
    );

    expect(populatedFields.length).toBeGreaterThanOrEqual(5);
    expect(traits.avg_sentence_length).toBeDefined();
    expect(typeof traits.avg_sentence_length).toBe('number');
    expect(traits.lexicon_size).toBeDefined();
    expect(typeof traits.lexicon_size).toBe('number');
    expect(traits.formality_score).toBeDefined();
    expect(typeof traits.formality_score).toBe('number');
    expect(traits.top_phrases).toBeDefined();
    expect(Array.isArray(traits.top_phrases)).toBe(true);
    expect(traits.sentence_length_distribution).toBeDefined();
    expect(Array.isArray(traits.sentence_length_distribution)).toBe(true);
  });

  it('respects manual_lock fields', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i} with some content here.`,
      timestamp: new Date(`2025-01-01T10:0${i}:00Z`),
    }));

    const existing = {
      avg_sentence_length: 42,
      manual_lock: ['avg_sentence_length'],
    };

    const traits = extractTraits(messages, existing);

    expect(traits.avg_sentence_length).toBe(42);
  });

  it('returns empty traits for messages with empty content', () => {
    const messages = [
      { role: 'user' as const, content: '   ', timestamp: new Date() },
    ];

    const traits = extractTraits(messages);

    expect(traits.lexicon_size).toBe(0);
  });
});

describe('corrupt file handling', () => {
  it('throws on non-JSON file passed to telegram parser', async () => {
    const filePath = await writeTmp('corrupt.json', 'this is not json at all {{{');
    const messages = [];
    await expect(async () => {
      for await (const msg of parseTelegramJson(filePath)) {
        messages.push(msg);
      }
    }).rejects.toThrow();
  });

  it('returns empty for valid JSON with wrong structure', async () => {
    const filePath = await writeTmp('wrong_structure.json', JSON.stringify({ data: [1, 2, 3] }));
    const messages = [];
    for await (const msg of parseTelegramJson(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(0);
  });

  it('handles empty file gracefully', async () => {
    const filePath = await writeTmp('empty.jsonl', '');
    const messages = [];
    for await (const msg of parseGenericJsonl(filePath)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(0);
  });
});
