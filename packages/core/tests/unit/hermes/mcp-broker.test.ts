import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListTools, mockCallTool, mockAssertUrl, mockDecrypt, mockFetch } = vi.hoisted(() => ({
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
  mockAssertUrl: vi.fn().mockResolvedValue({ allowed: true, pinnedIp: '93.184.216.34' }),
  mockDecrypt: vi.fn().mockResolvedValue(JSON.stringify({ Authorization: 'Bearer testkey' })),
  mockFetch: vi.fn(),
}));

vi.mock('../../../src/services/llm-provider/index.js', () => ({
  assertUrlAllowed: mockAssertUrl,
  decryptApiKey: mockDecrypt,
  ssrfSafeFetch: mockFetch,
}));

vi.mock('../../../src/services/hermes/mcp-client.js', () => ({
  mcpListTools: mockListTools,
  mcpCallTool: mockCallTool,
  McpClientError: class extends Error {
    public readonly name = 'McpClientError';
    constructor(message: string) { super(message); }
  },
}));

import { buildBrokeredTools, invalidateCache, type BindingRow, type McpCatalogEntryRow } from '../../../src/services/hermes/mcp-broker.js';

const entryA: McpCatalogEntryRow = {
  id: 'ce-a', tenantId: 'tenant-1', scope: 'tenant', name: 'github', transport: 'http',
  url: 'https://mcp.github.com', command: null, args: null, authCiphertext: null, authRef: null,
  toolsInclude: null, toolsExclude: null, timeoutMs: 30000, tlsVerify: true, enabled: true,
};

const entryB: McpCatalogEntryRow = { ...entryA, id: 'ce-b', name: 'calendar', url: 'https://mcp.calendar.com' };

const makeBinding = (entryId: string, overrides?: Partial<BindingRow>): BindingRow => ({
  id: `bind-${entryId}`, tenantId: 'tenant-1', personaId: 'persona-1',
  catalogEntryId: entryId, enabled: true, toolOverrides: null, ...overrides,
});

describe('mcp-broker (T009 — US2)', () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateCache(); });

  it('synthesizes namespaced tools from discovered entries', async () => {
    mockListTools.mockResolvedValueOnce([{ name: 'create_issue', description: 'Create', inputSchema: {} }]);

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding('ce-a')], [entryA]);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('mcp_github_create_issue');
    expect(result.allowlistEntries[0].id).toBe('mcp_github_create_issue');
  });

  it('un-annotated tool defaults to isWrite=true (write-treatment)', async () => {
    mockListTools.mockResolvedValueOnce([{ name: 'risky_op', description: 'Risky', inputSchema: {} }]);

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding('ce-a')], [entryA]);

    expect(result.tools[0].isWriteAction).toBe(true);
    expect(result.allowlistEntries[0].isWrite).toBe(true);
  });

  it('applies binding overrides for isWrite/requiresConfirmation', async () => {
    mockListTools.mockResolvedValueOnce([{ name: 'create_issue', description: 'Create', inputSchema: {} }]);

    const binding = makeBinding('ce-a', { toolOverrides: [{ name: 'create_issue', isWrite: false, requiresConfirmation: false }] });
    const result = await buildBrokeredTools('tenant-1', 'persona-1', [binding], [entryA]);

    expect(result.tools[0].isWriteAction).toBe(false);
    expect(result.tools[0].requiresConfirmation).toBe(false);
  });

  it('degrades gracefully when MCP server is unreachable', async () => {
    mockListTools.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding('ce-a')], [entryA]);

    expect(result.tools).toHaveLength(0);
    expect(result.health[0].status).toBe('degraded');
  });

  it('uses cache on second call within TTL', async () => {
    mockListTools.mockResolvedValue([{ name: 'tool1', description: 'T1', inputSchema: {} }]);
    const bindings = [makeBinding('ce-a')], entries = [entryA];

    await buildBrokeredTools('tenant-1', 'persona-1', bindings, entries);
    await buildBrokeredTools('tenant-1', 'persona-1', bindings, entries);

    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('discovers multiple entries in parallel', async () => {
    mockListTools
      .mockResolvedValueOnce([{ name: 'issue', description: 'I', inputSchema: {} }])
      .mockResolvedValueOnce([{ name: 'event', description: 'E', inputSchema: {} }]);

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding('ce-a'), makeBinding('ce-b')], [entryA, entryB]);

    expect(result.tools).toHaveLength(2);
    expect(result.tools.map(t => t.name).sort()).toEqual(['mcp_calendar_event', 'mcp_github_issue']);
  });

  it('applies tools_exclude filter', async () => {
    mockListTools.mockResolvedValueOnce([
      { name: 'create_issue', description: 'C', inputSchema: {} },
      { name: 'delete_issue', description: 'D', inputSchema: {} },
    ]);

    const entryWithExclude = { ...entryA, toolsExclude: ['delete_issue'] };
    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding('ce-a')], [entryWithExclude]);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('mcp_github_create_issue');
  });

  it('handler wraps result in untrusted_tool_result fence', async () => {
    mockListTools.mockResolvedValueOnce([{ name: 'echo', description: 'Echo', inputSchema: {} }]);
    mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'prompt-injection-attempt' }] });

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding('ce-a')], [entryA]);
    const handlerResult = await result.tools[0].handler({}, { tenantId: 't1', personaId: 'p1' });

    expect(handlerResult).toContain('<untrusted_tool_result>');
    expect(handlerResult).toContain('prompt-injection-attempt');
    expect(handlerResult).toContain('</untrusted_tool_result>');
  });
});
