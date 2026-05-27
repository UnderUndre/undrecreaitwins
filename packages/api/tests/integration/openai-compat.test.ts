import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatResponse } from '@undrecreaitwins/core/services/chat-service.js';

const mockChatResponse: ChatResponse = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'test-persona',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Hello!' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  metadata: { conversation_id: 'conv-123' },
};

const chatServiceMocks = {
  complete: vi.fn().mockResolvedValue(mockChatResponse),
};

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: {},
  healthCheck: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  withTenantContext: vi.fn<(_id: string, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (_id, fn) => fn({})),
}));

vi.mock('@undrecreaitwins/core/middleware/tenant.js', () => ({
  tenantPlugin: async (fastify: FastifyInstance) => {
    fastify.addHook('onRequest', async (request: { tenantId: string }) => {
      request.tenantId = 'test-tenant-123';
    });
  },
}));

vi.mock('@undrecreaitwins/core/middleware/auth.js', () => ({
  authPlugin: async () => {},
}));

vi.mock('@undrecreaitwins/core/middleware/error-handler.js', () => ({
  errorHandler: (error: { statusCode?: number; message: string; toJSON?: () => unknown }, _request: unknown, reply: { status: (code: number) => { send: (body: unknown) => void } }) => {
    const status = error.statusCode ?? 500;
    const body = typeof error.toJSON === 'function' ? error.toJSON() : { error: { code: 'internal_error', message: error.message } };
    return reply.status(status).send(body);
  },
}));

vi.mock('@undrecreaitwins/memory/letta-client.js', () => ({
  LettaClient: vi.fn().mockImplementation(() => ({
    isAvailable: vi.fn().mockReturnValue(false),
    getMemory: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@undrecreaitwins/core/services/persona-repository.js', () => ({
  PersonaRepository: vi.fn().mockImplementation(() => ({
    getBySlug: vi.fn().mockResolvedValue({
      id: 'persona-001',
      tenantId: 'test-tenant-123',
      name: 'Test Persona',
      slug: 'test-persona',
      systemPrompt: 'You are a test',
      traits: {},
      modelPreferences: {},
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      version: BigInt(1),
    }),
  })),
}));

vi.mock('@undrecreaitwins/core/services/chat-service.js', () => ({
  ChatService: vi.fn().mockImplementation(() => chatServiceMocks),
}));

const { buildServer } = await import('../../src/server.js');
const { chatCompletionsRoutes } = await import('../../src/routes/chat-completions.js');

async function setupTestServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  await server.register(chatCompletionsRoutes);
  return server;
}

function resetMocks() {
  chatServiceMocks.complete.mockResolvedValue(mockChatResponse);
}

describe('OpenAI compatibility — single-shot completion', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('response shape matches OpenAI chat completion spec', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-persona',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(typeof body.id).toBe('string');
    expect(body.id).toBe('chatcmpl-test');

    expect(body.object).toBe('chat.completion');

    expect(typeof body.created).toBe('number');
    expect(body.created).toBeGreaterThan(0);
    expect(Number.isInteger(body.created)).toBe(true);

    expect(body.model).toBe('test-persona');

    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(typeof body.choices[0].message.content).toBe('string');
    expect(body.choices[0].finish_reason).toBe('stop');

    expect(body.usage).toBeDefined();
    expect(typeof body.usage.prompt_tokens).toBe('number');
    expect(typeof body.usage.completion_tokens).toBe('number');
    expect(typeof body.usage.total_tokens).toBe('number');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });
});

describe('OpenAI compatibility — streaming', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('returns text/event-stream with SSE chunks and data: [DONE]', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-persona',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const body = response.body;
    const lines = body.split('\n\n').filter((line: string) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const contentLine = lines[0]!;
    expect(contentLine.startsWith('data: ')).toBe(true);
    const contentPayload = JSON.parse(contentLine.slice(6));
    expect(contentPayload.object).toBe('chat.completion.chunk');
    expect(contentPayload.choices[0].delta.role).toBe('assistant');
    expect(contentPayload.choices[0].delta.content).toBe('Hello!');

    const doneLine = lines[lines.length - 1]!;
    expect(doneLine).toBe('data: [DONE]');
  });
});

describe('OpenAI compatibility — system + user messages', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('accepts system role in messages array', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-persona',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
  });
});

describe('OpenAI compatibility — multi-turn conversation', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('accepts messages array with multiple user/assistant entries', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-persona',
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'And 3+3?' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hello!');
  });
});

describe('OpenAI compatibility — model not found', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('returns error shape with 404 for unknown model', async () => {
    const { NotFoundError } = await import('@undrecreaitwins/shared');
    chatServiceMocks.complete.mockRejectedValue(new NotFoundError('Persona', 'missing-persona'));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'missing-persona',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
  });
});

describe('OpenAI compatibility — response headers', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('non-streaming returns application/json', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-persona',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('streaming returns text/event-stream', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-persona',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
  });
});
