import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mockPersona = {
  id: 'persona-001',
  tenantId: 'test-tenant-123',
  name: 'Test Persona',
  slug: 'test-persona',
  systemPrompt: 'You are a test',
  traits: {},
  modelPreferences: {},
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  version: BigInt(1),
};

const repoMocks = {
  create: vi.fn().mockResolvedValue(mockPersona),
  getById: vi.fn().mockResolvedValue(mockPersona),
  getBySlug: vi.fn().mockResolvedValue(mockPersona),
  list: vi.fn().mockResolvedValue({ data: [mockPersona], total: 1 }),
  update: vi.fn().mockResolvedValue({ ...mockPersona, name: 'Updated' }),
  delete: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@undrecreaitwins/core/services/persona-repository.js', () => ({
  PersonaRepository: vi.fn().mockImplementation(() => repoMocks),
}));

const { buildServer } = await import('../../src/server.js');
const { personaRoutes } = await import('../../src/routes/personas.js');

async function setupTestServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  await server.register(personaRoutes);
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

describe('POST /v1/personas', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('creates a persona and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas',
      payload: {
        name: 'Test Persona',
        slug: 'test-persona',
        system_prompt: 'You are a test',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe('persona-001');
    expect(body.name).toBe('Test Persona');
    expect(body.slug).toBe('test-persona');
    expect(body.system_prompt).toBe('You are a test');
  });

  it('returns 400 for invalid slug format', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas',
      payload: {
        name: 'Test Persona',
        slug: 'INVALID SLUG!',
        system_prompt: 'You are a test',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('returns 400 when name is missing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/personas',
      payload: {
        slug: 'test-persona',
        system_prompt: 'You are a test',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('validation_error');
  });
});

describe('GET /v1/personas', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('returns paginated list with 200', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.total).toBe(1);
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });
});

describe('GET /v1/personas/:id', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('returns persona by ID with 200', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas/persona-001',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe('persona-001');
    expect(body.name).toBe('Test Persona');
  });

  it('returns 404 when persona not found', async () => {
    const { NotFoundError } = await import('@undrecreaitwins/shared');
    repoMocks.getById.mockRejectedValue(new NotFoundError('Persona', 'nonexistent'));

    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('not_found');
  });
});

describe('PATCH /v1/personas/:id', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('updates persona and returns 200', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: '/v1/personas/persona-001',
      payload: {
        name: 'Updated',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe('Updated');
  });

  it('returns 409 on version conflict', async () => {
    const { ConflictError } = await import('@undrecreaitwins/shared');
    repoMocks.update.mockRejectedValue(new ConflictError('Version conflict — persona was modified by another operation'));

    const response = await server.inject({
      method: 'PATCH',
      url: '/v1/personas/persona-001',
      headers: { 'If-Match': '999' },
      payload: { name: 'Updated' },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('conflict');
  });
});

describe('DELETE /v1/personas/:id', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetMocks();
    server = await setupTestServer();
  });

  it('deletes persona and returns 204', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/v1/personas/persona-001',
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 404 when persona not found', async () => {
    const { NotFoundError } = await import('@undrecreaitwins/shared');
    repoMocks.delete.mockRejectedValue(new NotFoundError('Persona', 'nonexistent'));

    const response = await server.inject({
      method: 'DELETE',
      url: '/v1/personas/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('not_found');
  });
});
