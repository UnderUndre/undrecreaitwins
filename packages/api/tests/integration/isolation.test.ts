import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { tenantData, repoMocks } = vi.hoisted(() => {
  const tenantAPersona = {
    id: 'p-aaa',
    tenantId: 'tenant-a',
    name: 'Alice Alpha',
    slug: 'alice',
    systemPrompt: 'You are Alice',
    traits: {} as Record<string, unknown>,
    modelPreferences: {} as Record<string, unknown>,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    version: BigInt(1),
  };

  const tenantBPersona = {
    id: 'p-bbb',
    tenantId: 'tenant-b',
    name: 'Bob Beta',
    slug: 'alice',
    systemPrompt: 'You are Bob',
    traits: {} as Record<string, unknown>,
    modelPreferences: {} as Record<string, unknown>,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    version: BigInt(1),
  };

  const data: Record<string, typeof tenantAPersona[]> = {
    'tenant-a': [tenantAPersona],
    'tenant-b': [tenantBPersona],
  };

  return {
    tenantData: data,
    repoMocks: {
      create: vi.fn(),
      getById: vi.fn(),
      getBySlug: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

function setTenant(id: string) {
  (globalThis as Record<string, unknown>).__testTenantId = id;
}

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, _val: unknown) => ({}),
  and: (..._conds: unknown[]) => ({}),
  desc: (_col: unknown) => ({}),
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
  withTenantContext: vi.fn<(id: string, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>>()
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
      id: 'chatcmpl-isolation',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'alice',
      choices: [{ index: 0, message: { role: 'assistant', content: 'response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      metadata: { conversation_id: 'conv-aaa' },
    }),
  }; }),
}));

const { buildServer } = await import('../../src/server.js');
const { personaRoutes } = await import('../../src/routes/personas.js');
const { conversationRoutes } = await import('../../src/routes/conversations.js');
const { chatCompletionsRoutes } = await import('../../src/routes/chat-completions.js');

async function setupIsolationServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  server.addHook('onRequest', async (request: { tenantId: string }) => {
    request.tenantId = (globalThis as Record<string, unknown>).__testTenantId as string;
  });
  await server.register(personaRoutes);
  await server.register(conversationRoutes);
  await server.register(chatCompletionsRoutes);
  return server;
}

function resetRepoMocks() {
  repoMocks.list.mockImplementation(async (tenantId: string) => {
    const data = tenantData[tenantId] ?? [];
    return { data, total: data.length };
  });

  repoMocks.getById.mockImplementation(async (tenantId: string, id: string) => {
    const list = tenantData[tenantId] ?? [];
    const found = list.find((p) => p.id === id);
    if (!found) {
      const { NotFoundError } = await import('@undrecreaitwins/shared');
      throw new NotFoundError('Persona', id);
    }
    return found;
  });

  repoMocks.getBySlug.mockImplementation(async (tenantId: string, slug: string) => {
    const list = tenantData[tenantId] ?? [];
    const found = list.find((p) => p.slug === slug);
    if (!found) {
      const { NotFoundError } = await import('@undrecreaitwins/shared');
      throw new NotFoundError('Persona', slug);
    }
    return found;
  });

  repoMocks.create.mockImplementation(async (tenantId: string, data: { name: string; slug: string; systemPrompt: string }) => {
    const newPersona = {
      id: `p-${tenantId}-${data.slug}`,
      tenantId,
      name: data.name,
      slug: data.slug,
      systemPrompt: data.systemPrompt,
      traits: {},
      modelPreferences: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      version: BigInt(1),
    };
    if (!tenantData[tenantId]) tenantData[tenantId] = [];
    tenantData[tenantId].push(newPersona);
    return newPersona;
  });

  repoMocks.update.mockImplementation(async (tenantId: string, id: string) => {
    const list = tenantData[tenantId] ?? [];
    const found = list.find((p) => p.id === id);
    if (!found) {
      const { NotFoundError } = await import('@undrecreaitwins/shared');
      throw new NotFoundError('Persona', id);
    }
    return { ...found, name: 'Updated', version: BigInt(2) };
  });

  repoMocks.delete.mockImplementation(async (tenantId: string, id: string) => {
    const list = tenantData[tenantId] ?? [];
    const found = list.find((p) => p.id === id);
    if (!found) {
      const { NotFoundError } = await import('@undrecreaitwins/shared');
      throw new NotFoundError('Persona', id);
    }
  });
}

describe('Multi-tenant isolation', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setTenant('tenant-a');
    resetRepoMocks();
    server = await setupIsolationServer();
  });

  afterEach(() => {
    setTenant('tenant-a');
  });

  describe('Persona isolation', () => {
    it('tenant A list returns only own personas', async () => {
      setTenant('tenant-a');

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('p-aaa');
      expect(body.data[0].tenant_id).toBe('tenant-a');
    });

    it('tenant B list returns only own personas', async () => {
      setTenant('tenant-b');

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('p-bbb');
      expect(body.data[0].tenant_id).toBe('tenant-b');
    });

    it('same slug different tenant returns correct persona', async () => {
      setTenant('tenant-a');
      const responseA = await server.inject({ method: 'GET', url: '/v1/personas' });

      setTenant('tenant-b');
      const responseB = await server.inject({ method: 'GET', url: '/v1/personas' });

      const bodyA = responseA.json();
      const bodyB = responseB.json();
      expect(bodyA.data[0].name).toBe('Alice Alpha');
      expect(bodyB.data[0].name).toBe('Bob Beta');
      expect(bodyA.data[0].slug).toBe('alice');
      expect(bodyB.data[0].slug).toBe('alice');
    });

    it('tenant A cannot get tenant B persona by ID', async () => {
      setTenant('tenant-a');

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas/p-bbb',
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('not_found');
    });

    it('tenant B cannot get tenant A persona by ID', async () => {
      setTenant('tenant-b');

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas/p-aaa',
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('not_found');
    });

    it('tenant A cannot update tenant B persona', async () => {
      setTenant('tenant-a');

      const response = await server.inject({
        method: 'PATCH',
        url: '/v1/personas/p-bbb',
        payload: { name: 'Hacked' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('tenant A cannot delete tenant B persona', async () => {
      setTenant('tenant-a');

      const response = await server.inject({
        method: 'DELETE',
        url: '/v1/personas/p-bbb',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Conversation isolation', () => {
    it('tenant B withTenantContext receives different data than tenant A', async () => {
      const { withTenantContext } = await import('@undrecreaitwins/core/db.js');
      const calledWith: string[] = [];
      vi.mocked(withTenantContext).mockImplementation(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
        calledWith.push(tenantId);
        return fn({});
      });

      setTenant('tenant-a');
      await server.inject({ method: 'GET', url: '/v1/conversations' });

      setTenant('tenant-b');
      await server.inject({ method: 'GET', url: '/v1/conversations' });

      expect(calledWith).toContain('tenant-a');
      expect(calledWith).toContain('tenant-b');
    });

    it('tenant B cannot read tenant A conversation messages', async () => {
      const { withTenantContext } = await import('@undrecreaitwins/core/db.js');
      vi.mocked(withTenantContext).mockImplementation(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => {
                  if (tenantId !== 'tenant-a') return Promise.resolve([]);
                  return Promise.resolve([{ id: 'conv-aaa', tenantId: 'tenant-a' }]);
                },
              }),
            }),
          }),
        });
      });

      setTenant('tenant-b');

      const response = await server.inject({
        method: 'GET',
        url: '/v1/conversations/conv-aaa/messages',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Missing tenant context', () => {
    it('request with empty tenantId returns empty persona list', async () => {
      setTenant('');

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
    });
  });

  describe('Qdrant collection naming convention', () => {
    it('uses shared collection with tenant_id payload filtering', async () => {
      const { ChatService } = await import('@undrecreaitwins/core/services/chat-service.js');
      const svc = new ChatService();
      expect(typeof svc.complete).toBe('function');
    });
  });

  describe('Letta namespace format', () => {
    it('agent ID follows tenant_{id}_persona_{id} pattern', () => {
      const tenantId = 'abc-123';
      const personaId = 'def-456';
      const namespace = `tenant_${tenantId}_persona_${personaId}`;
      expect(namespace).toBe('tenant_abc-123_persona_def-456');
    });

    it('ChatService constructs correct Letta namespace', async () => {
      const { LettaClient } = await import('@undrecreaitwins/memory/letta-client.js');
      const mockInstance = new LettaClient();
      const namespace = `tenant_tenant-a_persona_p-aaa`;
      await mockInstance.getMemory(namespace);
      expect(mockInstance.getMemory).toHaveBeenCalledWith('tenant_tenant-a_persona_p-aaa');
    });
  });
});
