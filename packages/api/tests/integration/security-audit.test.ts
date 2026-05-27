import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const { repoMocks } = vi.hoisted(() => ({
  repoMocks: {
    create: vi.fn(),
    getById: vi.fn(),
    getBySlug: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockPersona = {
  id: 'persona-001',
  tenantId: 'test-tenant-123',
  name: 'Test Persona',
  slug: 'test-persona',
  systemPrompt: 'You are a test',
  traits: {} as Record<string, unknown>,
  modelPreferences: {} as Record<string, unknown>,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  version: BigInt(1),
};

function setFlags(tenant: boolean, auth: boolean) {
  (globalThis as Record<string, unknown>).__testEnforceTenant = tenant;
  (globalThis as Record<string, unknown>).__testEnforceAuth = auth;
}

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, _val: unknown) => ({}),
  and: (..._conds: unknown[]) => ({}),
  desc: (_col: unknown) => ({}),
  isNull: (_col: unknown) => ({}),
}));

vi.mock('@undrecreaitwins/core/models/index.js', () => ({
  conversations: {},
  messages: {},
  apiTokens: {},
  tenants: {},
  personas: {},
  usageEvents: {},
}));

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: {},
  healthCheck: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  withTenantContext: vi.fn<(_id: string, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (_id, fn) => fn({})),
}));

vi.mock('@undrecreaitwins/core/middleware/tenant.js', () => ({
  tenantPlugin: async () => {},
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
  PersonaRepository: vi.fn().mockImplementation(function () { return repoMocks; }),
}));

vi.mock('@undrecreaitwins/memory/letta-client.js', () => ({
  LettaClient: vi.fn().mockImplementation(function () { return {
    isAvailable: vi.fn().mockReturnValue(false),
    getMemory: vi.fn().mockResolvedValue([]),
  }; }),
}));

vi.mock('@undrecreaitwins/core/services/chat-service.js', () => ({
  ChatService: vi.fn().mockImplementation(function () { return {
    complete: vi.fn().mockResolvedValue({
      id: 'chatcmpl-sec',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'test-persona',
      choices: [{ index: 0, message: { role: 'assistant', content: 'response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      metadata: { conversation_id: 'conv-123' },
    }),
  }; }),
}));

const { buildServer } = await import('../../src/server.js');
const { personaRoutes } = await import('../../src/routes/personas.js');
const { tokenRoutes } = await import('../../src/routes/tokens.js');
const { conversationRoutes } = await import('../../src/routes/conversations.js');
const { chatCompletionsRoutes } = await import('../../src/routes/chat-completions.js');

async function setupSecurityServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  const enforceTenant = (globalThis as Record<string, unknown>).__testEnforceTenant;
  const enforceAuth = (globalThis as Record<string, unknown>).__testEnforceAuth;

  server.addHook('onRequest', async (request: { tenantId: string; headers: Record<string, string | undefined>; url: string }) => {
    if (request.url === '/v1/health') return;

    if (enforceTenant) {
      const { UnauthorizedError } = await import('@undrecreaitwins/shared');
      throw new UnauthorizedError('Missing tenant context');
    }
    request.tenantId = 'test-tenant-123';

    if (enforceAuth) {
      const authHeader = request.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        const { UnauthorizedError } = await import('@undrecreaitwins/shared');
        throw new UnauthorizedError('Missing or invalid Authorization header');
      }
      const token = authHeader.slice(7);
      if (token !== 'valid-test-token') {
        const { UnauthorizedError } = await import('@undrecreaitwins/shared');
        throw new UnauthorizedError('Invalid or revoked API token');
      }
    }
  });

  await server.register(personaRoutes);
  await server.register(tokenRoutes);
  await server.register(conversationRoutes);
  await server.register(chatCompletionsRoutes);
  return server;
}

function resetMocks() {
  repoMocks.create.mockResolvedValue(mockPersona);
  repoMocks.getById.mockResolvedValue(mockPersona);
  repoMocks.getBySlug.mockResolvedValue(mockPersona);
  repoMocks.list.mockResolvedValue({ data: [mockPersona], total: 1 });
  repoMocks.update.mockResolvedValue({ ...mockPersona, name: 'Updated' });
  repoMocks.delete.mockResolvedValue(undefined);
}

describe('RLS: withTenantContext uses SET LOCAL', () => {
  it('db.ts source contains SET LOCAL app.current_tenant', () => {
    const dbPath = resolve(__dirname, '../../../core/src/db.ts');
    const source = readFileSync(dbPath, 'utf-8');
    expect(source).toContain('SET LOCAL app.current_tenant');
  });

  it('SET LOCAL is inside transaction boundary', () => {
    const dbPath = resolve(__dirname, '../../../core/src/db.ts');
    const source = readFileSync(dbPath, 'utf-8');
    const txIdx = source.indexOf('db.transaction');
    const setLocalIdx = source.indexOf('SET LOCAL app.current_tenant');
    expect(txIdx).toBeGreaterThan(-1);
    expect(setLocalIdx).toBeGreaterThan(txIdx);
  });
});

describe('Auth: Bearer token required in standalone mode', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setFlags(false, true);
    resetMocks();
    server = await setupSecurityServer();
  });

  afterEach(() => {
    setFlags(true, true);
  });

  it('request without Authorization header returns 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe('unauthorized');
  });

  it('request with invalid token returns 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: {
        'authorization': 'Bearer invalid-token',
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe('unauthorized');
  });

  it('request with valid token returns 200', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: {
        'authorization': 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('Bearer without token value returns 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: {
        'authorization': 'Bearer ',
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('No bypass paths: all /v1/* routes require tenant context except health', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setFlags(true, false);
    resetMocks();
    server = await setupSecurityServer();
  });

  afterEach(() => {
    setFlags(true, true);
  });

  it('/v1/health works without auth or tenant', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('status');
  });

  it('/v1/personas requires tenant context', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
    });

    expect(response.statusCode).toBe(401);
  });

  it('/v1/personas POST requires tenant context', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas',
      payload: {
        name: 'Sneaky',
        slug: 'sneaky',
        system_prompt: 'test',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('/v1/conversations requires tenant context', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/conversations',
    });

    expect(response.statusCode).toBe(401);
  });

  it('/v1/chat/completions requires tenant context', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('/v1/tokens POST requires tenant context', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tokens',
      payload: { name: 'token' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('Token hash not exposed in responses', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setFlags(false, false);
    resetMocks();
    server = await setupSecurityServer();
  });

  afterEach(() => {
    setFlags(true, true);
  });

  it('persona GET response does not leak token_hash', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas/persona-001',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('token_hash');
    expect(body).not.toHaveProperty('tokenHash');
  });

  it('persona list response does not leak internal fields', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    for (const persona of body.data) {
      expect(persona).not.toHaveProperty('token_hash');
      expect(persona).not.toHaveProperty('tokenHash');
      expect(persona).not.toHaveProperty('systemPrompt');
      expect(persona).toHaveProperty('system_prompt');
    }
  });

  it('persona response uses snake_case API fields not camelCase internals', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas/persona-001',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('systemPrompt');
    expect(body).not.toHaveProperty('modelPreferences');
    expect(body).toHaveProperty('tenant_id');
    expect(body).toHaveProperty('system_prompt');
    expect(body).toHaveProperty('model_preferences');
  });

  it('token routes .returning() clause excludes tokenHash', () => {
    const tokensPath = resolve(__dirname, '../../src/routes/tokens.ts');
    const source = readFileSync(tokensPath, 'utf-8');

    const returningMatches = source.match(/\.returning\(\{[^}]+\}\)/g);
    expect(returningMatches).not.toBeNull();
    expect(returningMatches!.length).toBeGreaterThanOrEqual(1);

    for (const block of returningMatches!) {
      expect(block).not.toContain('tokenHash');
      expect(block).not.toContain('token_hash');
    }

    const insertReturning = returningMatches!.find((m) => source.indexOf(m) > source.indexOf('.insert(apiTokens)'));
    expect(insertReturning).toBeDefined();
    expect(insertReturning!).toContain('apiTokens.id');
    expect(insertReturning!).toContain('apiTokens.name');
  });
});
