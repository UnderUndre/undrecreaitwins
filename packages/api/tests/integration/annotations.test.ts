import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

const mockAnnotationId = 'anno-123';

const serviceMocks = {
  upsert: vi.fn().mockResolvedValue(mockAnnotationId),
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@undrecreaitwins/core/services/index.js', () => ({
  AnnotationService: vi.fn().mockImplementation(() => serviceMocks),
  embeddingService: {},
  langfuseService: {
    pushToDataset: vi.fn().mockResolvedValue('dataset-item-123'),
  },
}));

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: {},
  healthCheck: vi.fn().mockResolvedValue(true),
  withTenantContext: vi.fn().mockImplementation(async (_id, fn) => fn({})),
}));

vi.mock('@undrecreaitwins/core/middleware/tenant.js', () => {
  const plugin = async (fastify: any) => {
    fastify.decorateRequest('tenantId', '');
    fastify.addHook('onRequest', async (request: any) => {
      request.tenantId = request.headers['x-tenant-id'] || 'test-tenant-123';
    });
  };
  (plugin as any)[Symbol.for('skip-override')] = true;
  return { tenantPlugin: plugin };
});

vi.mock('@undrecreaitwins/core/middleware/auth.js', () => ({
  authPlugin: async () => {},
}));

describe('Annotation Routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = await buildServer();
  });

  it('POST /v1/assistants/:id/annotations should upsert correction', async () => {
    const payload = {
      original_query: 'test query',
      bad_response: 'bad response',
      corrected_response: 'corrected response',
    };

    const response = await server.inject({
      method: 'POST',
      url: '/v1/assistants/persona-123/annotations',
      payload,
      headers: { 'x-tenant-id': 'test-tenant-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ 
      id: mockAnnotationId,
      langfuse_dataset_item_id: 'dataset-item-123'
    });
    expect(serviceMocks.upsert).toHaveBeenCalledWith('test-tenant-123', {
      personaId: 'persona-123',
      originalQuery: payload.original_query,
      badResponse: payload.bad_response,
      correctedResponse: payload.corrected_response,
    });
  });

  it('DELETE /v1/annotations/:id should delete annotation', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: `/v1/annotations/${mockAnnotationId}`,
      headers: { 'x-tenant-id': 'test-tenant-123' },
    });

    expect(response.statusCode).toBe(204);
    expect(serviceMocks.delete).toHaveBeenCalledWith('test-tenant-123', mockAnnotationId);
  });
});
