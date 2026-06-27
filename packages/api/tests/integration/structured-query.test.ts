import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

process.env.TWIN_AUTH_MODE = 'gateway';

const mockPersona = {
  id: 'persona-001',
  tenantId: 'test-tenant-123',
  name: 'Test Persona',
  slug: 'test-persona',
};

const personaRepoMocks = {
  getById: vi.fn().mockResolvedValue(mockPersona),
};

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: 'test-tenant-123', status: 'active' }]),
      }),
    }),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  }),
};

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: mockDb,
  healthCheck: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  withTenantContext: vi.fn<(_id: string, fn: (tx: any) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (_id, fn) => fn({ select: () => ({ from: () => [] }) })),
}));

vi.mock('@undrecreaitwins/core/middleware/tenant.js', () => ({
  tenantPlugin: async (fastify: FastifyInstance) => {
    fastify.addHook('onRequest', async (request: any) => {
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

vi.mock('@undrecreaitwins/core/services/persona-repository.js', () => ({
  PersonaRepository: vi.fn().mockImplementation(() => personaRepoMocks),
}));

const draftRepoMocks = {
  sweepStaleGenerating: vi.fn().mockResolvedValue(0),
};

vi.mock('@undrecreaitwins/core/services/tuning/tuning-draft-repository.js', () => ({
  TuningDraftRepository: vi.fn().mockImplementation(() => draftRepoMocks),
}));

const mockLlmClientInstance = {
  complete: vi.fn().mockResolvedValue({
    content: JSON.stringify({
      nodes: [{ id: 'n1', type: 'prompt', data: {} }],
      edges: [],
    }),
    model: 'gpt-4o',
    finishReason: 'stop',
    usage: {
      prompt_tokens: 124500,
      completion_tokens: 1820,
      total_tokens: 126320,
    },
  }),
};

const mockGroundingEngine = {
  query: vi.fn().mockResolvedValue([
    { text: 'Mock document context text 1' },
    { text: 'Mock document context text 2' },
  ]),
};

vi.mock('@undrecreaitwins/core/services/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    LLMClient: vi.fn().mockImplementation(() => mockLlmClientInstance),
    groundingEngine: mockGroundingEngine,
  };
});

let buildServerFn: any;
let structuredQueryRoutesFn: any;

async function setupTestServer(): Promise<FastifyInstance> {
  if (!buildServerFn) {
    const serverModule = await import('../../src/server.js');
    buildServerFn = serverModule.buildServer;
  }
  const server = await buildServerFn();
  return server;
}

describe('POST /v1/personas/:personaId/structured-query', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = await setupTestServer();
  });

  it('runs query through grounding engine and llm complete, returning formatted output', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/structured-query',
      headers: {
        'x-tenant-id': 'test-tenant-123',
      },
      payload: {
        systemPrompt: 'System prompt instructions...',
        userInstruction: 'Build me a support funnel.',
        responseFormat: { type: 'json_object' },
        maxTokens: 8000,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.content).toContain('nodes');
    expect(body.usage).toEqual({
      promptTokens: 124500,
      completionTokens: 1820,
    });

    // Verify groundingEngine.query was called with empty string as query
    expect(mockGroundingEngine.query).toHaveBeenCalledWith('', 'test-tenant-123', 'persona-001');

    // Verify llm.complete was called with the composed prompt and documents
    expect(mockLlmClientInstance.complete).toHaveBeenCalledWith({
      messages: [
        { role: 'system', content: 'System prompt instructions...' },
        { role: 'user', content: 'Build me a support funnel.\n\n<documents>\nMock document context text 1\n---\nMock document context text 2' },
      ],
      responseFormat: { type: 'json_object' },
      maxTokens: 8000,
      tenantId: 'test-tenant-123',
      personaId: 'persona-001',
    });
  });

  it('returns 400 validation error if systemPrompt is missing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/structured-query',
      headers: {
        'x-tenant-id': 'test-tenant-123',
      },
      payload: {
        userInstruction: 'No system prompt',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('returns 404 if persona does not exist', async () => {
    personaRepoMocks.getById.mockRejectedValueOnce(new Error('not found'));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-nonexistent/structured-query',
      headers: {
        'x-tenant-id': 'test-tenant-123',
      },
      payload: {
        systemPrompt: 'Instructions...',
      },
    });

    expect(response.statusCode).toBe(404);
  });
});
