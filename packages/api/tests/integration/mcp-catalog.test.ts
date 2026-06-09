import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { catalogStore, bindingStore } = vi.hoisted(() => {
  const catalog: Record<string, Record<string, unknown>[]> = {};
  const bindings: Record<string, Record<string, unknown>[]> = {};
  return { catalogStore: catalog, bindingStore: bindings };
});

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, _val: unknown) => ({}),
  and: (..._conds: unknown[]) => ({}),
  isNull: (_col: unknown) => ({}),
}));

const makeSelectChain = (tenantId: string) => ({
  from: () => ({
    where: () => ({
      limit: () => Promise.resolve(
        tenantId.startsWith('tenant-test')
          ? [{ id: tenantId, status: 'active' }]
          : [],
      ),
    }),
  }),
});

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
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
  healthCheck: vi.fn().mockResolvedValue(true),
  withTenantContext: vi.fn().mockImplementation(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    return fn({
      select: () => {
        const chain: any = {
          from: (table?: unknown) => {
            const isBinding = table && (table as Record<string, unknown>).catalogEntryId !== undefined;
            const store = isBinding ? bindingStore : catalogStore;
            const rows = store[tenantId] ?? [];
            const result: any = {
              where: () => Promise.resolve(rows),
            };
            result.then = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve);
            result.catch = () => result;
            result.finally = () => result;
            return result;
          },
        };
        return chain;
      },
      insert: () => ({
        values: (vals: Record<string, unknown>) => ({
          returning: () => {
            const isBindingRow = 'catalogEntryId' in vals || 'personaId' in vals;
            if (isBindingRow) {
              const entry = {
                id: 'bind-test-id', tenantId, personaId: vals.personaId ?? 'p-aaa',
                catalogEntryId: vals.catalogEntryId, enabled: vals.enabled ?? true,
                toolOverrides: vals.toolOverrides ?? [], createdAt: new Date(), updatedAt: new Date(),
              };
              if (!bindingStore[tenantId]) bindingStore[tenantId] = [];
              bindingStore[tenantId].push(entry);
              return Promise.resolve([entry]);
            }
            const entry = {
              id: 'test-id', tenantId, scope: 'tenant', transport: 'http',
              url: null, command: null, args: null,
              authCiphertext: null, authRef: null,
              toolsInclude: null, toolsExclude: null,
              timeoutMs: 30000, tlsVerify: true, enabled: true,
              createdAt: new Date(), updatedAt: new Date(),
              ...vals,
            };
            if (!catalogStore[tenantId]) catalogStore[tenantId] = [];
            catalogStore[tenantId].push(entry);
            return Promise.resolve([entry]);
          },
        }),
      }),
      update: () => ({
        set: (_data: unknown) => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 'test-id', tenantId }]),
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
    id: 'id', tenantId: 'tenant_id', name: 'name', url: 'url',
    scope: 'scope', transport: 'transport', enabled: 'enabled',
    authCiphertext: 'auth_ciphertext', authRef: 'auth_ref',
    toolsInclude: 'tools_include', toolsExclude: 'tools_exclude',
    timeoutMs: 'timeout_ms', tlsVerify: 'tls_verify',
  },
  assistantMcpBinding: {
    id: 'id', tenantId: 'tenant_id', personaId: 'persona_id',
    catalogEntryId: 'catalog_entry_id', enabled: 'enabled',
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

vi.mock('@undrecreaitwins/core/services/hermes/hermes-preflight.js', () => ({
  runHermesPreflight: vi.fn().mockResolvedValue({ ok: true, acpProtocolVersion: 1 }),
}));

vi.mock('@undrecreaitwins/core/services/hermes/honcho-client.js', () => ({
  setDegradationSignal: vi.fn(),
}));

vi.mock('@undrecreaitwins/core/services/retry/provider-retry.worker.js', () => ({
  ProviderRetryWorker: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
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
  let origAuthMode: string | undefined;

  beforeAll(() => {
    origAuthMode = process.env.TWIN_AUTH_MODE;
    process.env.TWIN_AUTH_MODE = 'gateway';
  });

  afterAll(() => {
    if (origAuthMode !== undefined) process.env.TWIN_AUTH_MODE = origAuthMode;
    else delete process.env.TWIN_AUTH_MODE;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    catalogStore[TENANT_A] = [];
    catalogStore[TENANT_B] = [];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: TENANT_A, status: 'active' }]),
        }),
      }),
    });

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
    expect(JSON.stringify(res.json())).toContain('stdio');
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
    expect(JSON.stringify(res.json())).toContain('SSRF');
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
    catalogStore[TENANT_A] = [{
      id: 'test-id', tenantId: TENANT_A, scope: 'tenant', name: 'gh', transport: 'http',
      url: 'https://mcp.example.com', command: null, args: null,
      authCiphertext: null, authRef: null,
      toolsInclude: null, toolsExclude: null,
      timeoutMs: 30000, tlsVerify: true, enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    }];

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
          catalog_entry_id: '00000000-0000-0000-0000-000000000001',
          enabled: true,
          tool_overrides: [{ name: 'create_issue', isWrite: true }],
        }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings).toHaveLength(1);
  });
});
