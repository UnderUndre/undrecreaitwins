import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { catalogStore, bindingStore } = vi.hoisted(() => {
  const catalog: Record<string, Record<string, unknown>[]> = {};
  const bindings: Record<string, Record<string, unknown>[]> = {};
  return {
    catalogStore: catalog,
    bindingStore: bindings,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, _val: unknown) => ({}),
  and: (..._conds: unknown[]) => ({}),
}));

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: {},
  healthCheck: vi.fn().mockResolvedValue(true),
  withTenantContext: vi.fn().mockImplementation(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    return fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(catalogStore[tenantId] ?? []),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => {
            const entry = { id: 'test-id', tenant_id: tenantId, scope: 'tenant', name: 'gh', transport: 'http', url: 'https://mcp.example.com', has_auth: false, tools_include: null, tools_exclude: null, timeout_ms: 30000, tls_verify: true, enabled: true, created_at: new Date(), updated_at: new Date() };
            if (!catalogStore[tenantId]) catalogStore[tenantId] = [];
            catalogStore[tenantId].push(entry);
            return Promise.resolve([entry]);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 'test-id', tenant_id: tenantId }]),
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 'test-id' }]),
        }),
      }),
    });
  }),
}));

vi.mock('@undrecreaitwins/core/models/index.js', () => ({
  mcpCatalogEntry: {
    id: 'id',
    tenantId: 'tenant_id',
    name: 'name',
    url: 'url',
    scope: 'scope',
    transport: 'transport',
    enabled: 'enabled',
    authCiphertext: 'auth_ciphertext',
    authRef: 'auth_ref',
    toolsInclude: 'tools_include',
    toolsExclude: 'tools_exclude',
    timeoutMs: 'timeout_ms',
    tlsVerify: 'tls_verify',
  },
  assistantMcpBinding: {
    id: 'id',
    tenantId: 'tenant_id',
    personaId: 'persona_id',
    catalogEntryId: 'catalog_entry_id',
    enabled: 'enabled',
    toolOverrides: 'tool_overrides',
  },
  tenants: { id: 'id', status: 'status' },
  apiTokens: { id: 'id', tenantId: 'tenant_id', tokenHash: 'token_hash', revokedAt: 'revoked_at' },
}));

vi.mock('@undrecreaitwins/core/services/llm-provider/index.js', () => ({
  encryptApiKey: vi.fn().mockResolvedValue({ ciphertext: 'enc', keyRef: 'ref' }),
  assertUrlAllowed: vi.fn().mockResolvedValue({ allowed: true, pinnedIp: '93.184.216.34' }),
}));

vi.mock('@undrecreaitwins/core/services/hermes/mcp-client.js', () => ({
  mcpListTools: vi.fn().mockResolvedValue([
    { name: 'create_issue', description: 'Create an issue', inputSchema: {} },
  ]),
}));

vi.mock('@undrecreaitwins/core/services/hermes/mcp-broker.js', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@undrecreaitwins/shared', () => ({
  ValidationError: class extends Error {
    public readonly statusCode = 400;
    public readonly code = 'validation_error';
    constructor(public readonly issues: Array<{ field: string; message: string }>) {
      super(issues.map(i => i.message).join(', '));
    }
  },
  NotFoundError: class extends Error {
    public readonly statusCode = 404;
    public readonly code = 'not_found';
    constructor(public readonly entity: string, public readonly id: string) {
      super(`${entity} not found: ${id}`);
    }
  },
  UnauthorizedError: class extends Error {
    public readonly statusCode = 401;
    constructor(message: string) { super(message); }
  },
  ForbiddenError: class extends Error {
    public readonly statusCode = 403;
    constructor(message: string) { super(message); }
  },
  AppError: class extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

const { buildServer } = await import('../../src/server.js');

const TENANT_A = 'tenant-test-a';
const TENANT_B = 'tenant-test-b';

describe('MCP Catalog API (T003 — US1)', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    catalogStore[TENANT_A] = [];
    catalogStore[TENANT_B] = [];
    server = await buildServer();
  });

  it('POST /v1/mcp/catalog — rejects stdio transport for tenant', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: { name: 'local', transport: 'stdio' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('stdio');
  });

  it('POST /v1/mcp/catalog — rejects missing URL for http transport', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: { name: 'noserver' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/mcp/catalog — rejects invalid name (regex)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: { name: 'INVALID NAME!', url: 'https://mcp.example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/mcp/catalog — rejects name >20 chars', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: { name: 'this_name_is_way_too_long_for_llm', url: 'https://mcp.example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/mcp/catalog — SSRF rejects private IP', async () => {
    const { assertUrlAllowed } = await import('@undrecreaitwins/core/services/llm-provider/index.js');
    vi.mocked(assertUrlAllowed).mockResolvedValueOnce({ allowed: false, reason: 'private IP 127.0.0.1' });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: { name: 'evil', url: 'http://127.0.0.1/mcp' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('SSRF');
  });

  it('POST /v1/mcp/catalog — encrypts auth, never returns secret', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: { name: 'gh', url: 'https://mcp.example.com', auth: { Authorization: 'Bearer secret123' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.has_auth).toBe(true);
    expect(body.auth_ciphertext).toBeUndefined();
    expect(body.auth_ref).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret123');
  });

  it('GET /v1/mcp/catalog — returns tenant-scoped entries', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/mcp/catalog',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('data');
  });

  it('DELETE /v1/mcp/catalog/:id — returns 204 on success', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/v1/mcp/catalog/test-id',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('POST /v1/mcp/catalog/:id/rescan — returns discovered tools', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/mcp/catalog/test-id/rescan',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('create_issue');
  });

  it('PUT /v1/assistants/:personaId/mcp — replaces bindings', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/assistants/p-aaa/mcp',
      headers: { 'x-tenant-id': TENANT_A, authorization: 'Bearer test' },
      payload: {
        bindings: [{
          catalog_entry_id: 'ce-1',
          enabled: true,
          tool_overrides: [{ name: 'create_issue', isWrite: true }],
        }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings).toHaveLength(1);
  });
});
