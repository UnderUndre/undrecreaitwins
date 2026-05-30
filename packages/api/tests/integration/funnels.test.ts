import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mockFunnel = {
  id: 'funnel-001',
  tenantId: 'test-tenant-123',
  personaId: 'persona-001',
  name: 'Test Funnel',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const repoMocks = {
  createFunnel: vi.fn().mockResolvedValue(mockFunnel),
  createVersion: vi.fn().mockResolvedValue({ id: 'v1', definitionId: 'funnel-001', versionNumber: 1 }),
  deleteFunnel: vi.fn().mockResolvedValue(undefined),
  resetConversationState: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: {},
  healthCheck: vi.fn().mockResolvedValue(true),
  withTenantContext: vi.fn().mockImplementation(async (_id, fn) => fn({})),
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
  errorHandler: (error: any, _request: any, reply: any) => {
    const status = error.statusCode ?? 500;
    return reply.status(status).send({ error: { code: error.code || 'internal_error', message: error.message, details: error.details } });
  },
}));

vi.mock('@undrecreaitwins/core/services/funnel/funnel-repository.js', () => ({
  FunnelRepository: vi.fn().mockImplementation(() => repoMocks),
}));

const { buildServer } = await import('../../src/server.js');
const { funnelRoutes } = await import('../../src/routes/funnels.js');

describe('Funnels API (Integration)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
    await server.register(funnelRoutes);
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /v1/health returns ok', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(response.statusCode).toBe(200);
  });

  it('POST /v1/funnels creates a funnel', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/funnels',
      payload: {
        persona_id: '00000000-0000-0000-0000-000000000000',
        name: 'Test Funnel'
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe('funnel-001');
  });

  it('POST /v1/funnels/:id/versions creates a version', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/funnels/funnel-001/versions',
      payload: {
        config: {
          relevance_threshold: 7,
          off_script_behavior: 'steer',
          stuck_threshold: 3,
          stuck_action: 'yield_generation',
          scoring_weights: {
            exact_match: 10,
            stemmed_match: 7,
            synonym_match: 5,
            stage_boost: 3,
            next_stage_bonus: 1.5,
            objection_boost: 2
          }
        },
        stages: [
          {
            id: '00000000-0000-0000-0000-000000000001',
            name: 'Welcome',
            order: 1,
            resolutionCriteria: { type: 'all_slots_filled' },
            fragments: [
              { type: 'normal', content: 'Hi!', triggers: { phrases: ['hi'] } }
            ]
          }
        ]
      }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().id).toBe('v1');
  });

  it('POST /v1/conversations/:id/funnel/reset resets state', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/conversations/conv-1/funnel/reset',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('reset');
  });
});
