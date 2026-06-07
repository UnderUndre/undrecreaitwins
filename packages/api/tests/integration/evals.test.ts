import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => {
  const run = {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: 'test-tenant-123',
    startedAt: new Date('2026-06-04T10:00:00.000Z'),
    finishedAt: new Date('2026-06-04T10:01:00.000Z'),
    totalCases: 1,
    passedCases: 1,
  };
  const result = {
    id: '22222222-2222-2222-2222-222222222222',
    tenantId: 'test-tenant-123',
    runId: run.id,
    caseName: 'helpful-greeting',
    passed: true,
    response: 'Hello, I can help.',
    assertionResults: [{
      type: 'contains',
      passed: true,
      message: 'Response contains "help"',
    }],
    createdAt: new Date('2026-06-04T10:01:00.000Z'),
  };
  return {
    run,
    result,
    repository: {
      listRuns: vi.fn(),
      getRunWithResults: vi.fn(),
    },
    runner: {
      run: vi.fn(),
    },
    chatService: {
      complete: vi.fn(),
      completeStream: vi.fn(),
      persistMessages: vi.fn(),
      emitUsageEvent: vi.fn(),
    },
  };
});

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

vi.mock('@undrecreaitwins/core/services/chat-service.js', () => ({
  ChatService: vi.fn().mockImplementation(() => mocks.chatService),
}));

vi.mock('@undrecreaitwins/core/services/persona-repository.js', () => ({
  PersonaRepository: vi.fn().mockImplementation(() => ({
    getBySlug: vi.fn(),
  })),
}));

vi.mock('@undrecreaitwins/core/services/index.js', () => ({
  AnnotationService: vi.fn().mockImplementation(() => ({
    upsert: vi.fn(),
    delete: vi.fn(),
  })),
  langfuseService: {
    pushToDataset: vi.fn(),
  },
  embeddingService: {},
  documentService: {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@undrecreaitwins/core/services/eval-repository.js', () => ({
  EvalRepository: vi.fn().mockImplementation(() => mocks.repository),
}));

vi.mock('@undrecreaitwins/core/services/eval-runner.js', () => ({
  EvalRunner: vi.fn().mockImplementation(() => mocks.runner),
}));

const { buildServer } = await import('../../src/server.js');

describe('/v1/evals', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.repository.listRuns.mockResolvedValue({ data: [mocks.run], total: 1 });
    mocks.repository.getRunWithResults.mockResolvedValue({ run: mocks.run, results: [mocks.result] });
    mocks.runner.run.mockResolvedValue({ run: mocks.run, results: [mocks.result] });
    server = await buildServer();
  });

  it('lists eval runs', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/evals/runs',
      headers: {
        'X-Tenant-ID': 'test-tenant-123',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.data[0].id).toBe(mocks.run.id);
    expect(body.data[0].passed_cases).toBe(1);
    expect(mocks.repository.listRuns).toHaveBeenCalledWith('test-tenant-123', 20, 0);
  });

  it('returns eval run details', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/evals/runs/${mocks.run.id}`,
      headers: {
        'X-Tenant-ID': 'test-tenant-123',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(mocks.run.id);
    expect(body.results[0].case_name).toBe('helpful-greeting');
    expect(body.results[0].assertion_results[0].passed).toBe(true);
  });

  it('triggers an eval run', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/evals/run',
      headers: {
        'X-Tenant-ID': 'test-tenant-123',
      },
      payload: {
        case_names: ['helpful-greeting'],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe(mocks.run.id);
    expect(body.results).toHaveLength(1);
    expect(mocks.runner.run).toHaveBeenCalledWith('test-tenant-123', ['helpful-greeting']);
  });
});
