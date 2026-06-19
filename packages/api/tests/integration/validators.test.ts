import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '@undrecreaitwins/core/db.js';

type ResolveQueue = unknown[][];
let resolveQueue: ResolveQueue = [[]];

function shiftResolve(): unknown[] {
  const next = resolveQueue.shift();
  if (next instanceof Error) {
    throw next;
  }
  return (next as unknown[]) ?? [];
}

function createChainableMock() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => Promise.resolve(shiftResolve())),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(() => Promise.resolve(shiftResolve())),
    then: undefined as unknown as ((resolve: (v: unknown) => void) => void) | undefined,
  };

  chain.then = function (resolve: (v: unknown) => void) {
    resolve(shiftResolve());
  };

  return chain;
}

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: createChainableMock(),
  healthCheck: vi.fn().mockResolvedValue(true),
  withTenantContext: vi.fn(async (_id: string, fn: (tx: unknown) => Promise<unknown>) => {
    return fn(createChainableMock());
  }),
}));

vi.mock('@undrecreaitwins/core/middleware/tenant.js', () => ({
  tenantPlugin: async (fastify: FastifyInstance) => {
    fastify.addHook('onRequest', async (request: { tenantId: string }) => {
      request.tenantId = 'test-tenant';
    });
  },
}));

vi.mock('@undrecreaitwins/core/middleware/auth.js', () => ({
  authPlugin: async () => {},
}));

vi.mock('@undrecreaitwins/core/middleware/error-handler.js', () => ({
  errorHandler: (
    error: { statusCode?: number; message: string; toJSON?: () => unknown },
    _request: unknown,
    reply: { status: (code: number) => { send: (body: unknown) => void } },
  ) => {
    const status = error.statusCode ?? 500;
    const body =
      typeof error.toJSON === 'function'
        ? error.toJSON()
        : { error: { code: 'internal_error', message: error.message } };
    return reply.status(status).send(body);
  },
}));

const { buildServer } = await import('../../src/server.js');

async function createServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  await server.ready();
  return server;
}

describe('Validators routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.TWIN_AUTH_STATIC_TOKEN = 'test-token';
    resolveQueue = [[]];
    server = await createServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.TWIN_AUTH_STATIC_TOKEN;
  });

  describe('GET /v1/personas/:personaId/validators/language-guard', () => {
    it('returns defaults when no config exists', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [],
      ];

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.config.enabled).toBe(true);
      expect(body.config.allowedLanguages).toEqual([]);
      expect(body.config.mode).toBe('dry-run');
      expect(body.configVersion).toBe(0);
    });

    it('returns stored config when one exists', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [{
          id: 'cfg-001',
          tenantId: 'test-tenant',
          personaId: 'persona-001',
          validatorName: 'language-guard',
          mode: 'active',
          config: {
            enabled: true,
            allowedLanguages: ['en', 'fr'],
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          version: 3,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        }],
      ];

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.config.enabled).toBe(true);
      expect(body.config.allowedLanguages).toEqual(['en', 'fr']);
      expect(body.config.mode).toBe('active');
      expect(body.configVersion).toBe(3);
    });
  });

  describe('PUT /v1/personas/:personaId/validators/language-guard', () => {
    it('returns 400 when expectedVersion is missing', async () => {
      resolveQueue = [[{ id: 'test-tenant', status: 'active' }], [{ id: 'persona-001' }]];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['en'],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
        }),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('MISSING_EXPECTED_VERSION');
      expect(body.message).toBe('expectedVersion is required');
    });

    it('returns 400 when stripThreshold > blockThreshold', async () => {
      resolveQueue = [[{ id: 'test-tenant', status: 'active' }], [{ id: 'persona-001' }]];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['en'],
            mode: 'active',
            stripThreshold: 0.50,
            blockThreshold: 0.10,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('VALIDATION_FAILED');
      expect(body.fields.stripThreshold.code).toBe('THRESHOLD_ORDER');
    });

    it('returns 400 when mode is active but allowedLanguages is empty', async () => {
      resolveQueue = [[{ id: 'test-tenant', status: 'active' }], [{ id: 'persona-001' }]];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: [],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('VALIDATION_FAILED');
      expect(body.fields.allowedLanguages.code).toBe('EMPTY_ACTIVE_LANGUAGES');
    });

    it('returns 400 when BCP-47 code is invalid', async () => {
      resolveQueue = [[{ id: 'test-tenant', status: 'active' }], [{ id: 'persona-001' }]];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['INVALID-LANG'],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('VALIDATION_FAILED');
      expect(body.fields.allowedLanguages.code).toBe('INVALID_BCP47');
    });

    it('succeeds with INSERT when no existing config', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [],
        [{
          id: 'cfg-001',
          tenantId: 'test-tenant',
          personaId: 'persona-001',
          validatorName: 'language-guard',
          mode: 'active',
          config: JSON.stringify({
            enabled: true,
            allowedLanguages: ['en'],
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          }),
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      ];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['en'],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.config.enabled).toBe(true);
      expect(body.configVersion).toBe(1);
    });

    it('succeeds with UPDATE when expectedVersion matches', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [{
          id: 'cfg-001',
          tenantId: 'test-tenant',
          personaId: 'persona-001',
          validatorName: 'language-guard',
          mode: 'dry-run',
          config: JSON.stringify({
            enabled: true,
            allowedLanguages: ['en'],
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          }),
          version: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
        [{
          id: 'cfg-001',
          tenantId: 'test-tenant',
          personaId: 'persona-001',
          validatorName: 'language-guard',
          mode: 'active',
          config: JSON.stringify({
            enabled: true,
            allowedLanguages: ['en', 'fr'],
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          }),
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      ];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['en', 'fr'],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.config.mode).toBe('active');
      expect(body.config.allowedLanguages).toEqual(['en', 'fr']);
      expect(body.configVersion).toBe(1);
    });

    it('returns 409 when expectedVersion does not match', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [{
          id: 'cfg-001',
          tenantId: 'test-tenant',
          personaId: 'persona-001',
          validatorName: 'language-guard',
          mode: 'active',
          config: JSON.stringify({
            enabled: true,
            allowedLanguages: ['en'],
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          }),
          version: 5,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      ];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['de'],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toBe('CONFLICT');
      expect(body.currentVersion).toBe(5);
      expect(body.currentConfig).toBeDefined();
    });

    it('returns 409 when unique violation 23505 occurs', async () => {
      const dbError = new Error('Unique violation');
      (dbError as any).code = '23505';

      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [],
        dbError,
      ];

      const response = await server.inject({
        method: 'PUT',
        url: '/v1/personas/persona-001/validators/language-guard',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            enabled: true,
            allowedLanguages: ['en'],
            mode: 'active',
            stripThreshold: 0.05,
            blockThreshold: 0.30,
          },
          expectedVersion: 0,
        }),
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toBe('CONFLICT');
      expect(body.currentConfig).toBeNull();
      expect(body.currentVersion).toBe(0);
    });
  });

  describe('GET /v1/personas/:personaId/validators/language-guard/logs', () => {
    it('returns 400 when limit is 0', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
      ];

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas/persona-001/validators/language-guard/logs?limit=0',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('VALIDATION_FAILED');
      expect(body.fields.limit).toBe('limit must be >= 1');
    });

    it('returns 400 when cursor is invalid base64', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
      ];

      const response = await server.inject({
        method: 'GET',
        url: '/v1/personas/persona-001/validators/language-guard/logs?cursor=not-base64!',
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('INVALID_CURSOR');
    });

    it('returns 400 when cursor has invalid UUID', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
      ];

      const badUuidCursor = Buffer.from('2025-01-01T00:00:00.000Z_not-a-uuid').toString('base64');
      const response = await server.inject({
        method: 'GET',
        url: `/v1/personas/persona-001/validators/language-guard/logs?cursor=${badUuidCursor}`,
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('INVALID_CURSOR');
    });

    it('returns 400 when cursor has invalid date', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
      ];

      const badDateCursor = Buffer.from('invalid-date_12345678-1234-1234-1234-123456789012').toString('base64');
      const response = await server.inject({
        method: 'GET',
        url: `/v1/personas/persona-001/validators/language-guard/logs?cursor=${badDateCursor}`,
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('INVALID_CURSOR');
    });

    it('succeeds with 200 when cursor is valid', async () => {
      resolveQueue = [
        [{ id: 'test-tenant', status: 'active' }],
        [{ id: 'persona-001' }],
        [],
      ];

      const validCursor = Buffer.from('2025-01-01T00:00:00.000Z_12345678-1234-1234-1234-123456789012').toString('base64');
      const response = await server.inject({
        method: 'GET',
        url: `/v1/personas/persona-001/validators/language-guard/logs?cursor=${validCursor}`,
        headers: { 'x-tenant-id': 'test-tenant', 'authorization': 'Bearer test-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toEqual([]);
    });
  });
});
