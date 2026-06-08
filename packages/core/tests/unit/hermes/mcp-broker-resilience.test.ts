import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListTools, mockCallTool } = vi.hoisted(() => ({
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
}));

vi.mock('../../../src/services/llm-provider/index.js', () => ({
  assertUrlAllowed: vi.fn().mockResolvedValue({ allowed: true }),
  decryptApiKey: vi.fn().mockResolvedValue('{}'),
  ssrfSafeFetch: vi.fn(),
}));

vi.mock('../../../src/services/hermes/mcp-client.js', () => ({
  mcpListTools: mockListTools,
  mcpCallTool: mockCallTool,
  McpClientError: class extends Error { public readonly name = 'McpClientError'; },
}));

import { buildBrokeredTools, invalidateCache, type BindingRow, type McpCatalogEntryRow } from '../../../src/services/hermes/mcp-broker.js';

const entry: McpCatalogEntryRow = {
  id: 'ce-1', tenantId: 'tenant-1', scope: 'tenant', name: 'flaky', transport: 'http',
  url: 'https://mcp.flaky.com', command: null, args: null, authCiphertext: null, authRef: null,
  toolsInclude: null, toolsExclude: null, timeoutMs: 5000, tlsVerify: true, enabled: true,
};

const makeBinding = (): BindingRow => ({
  id: 'bind-1', tenantId: 'tenant-1', personaId: 'persona-1',
  catalogEntryId: 'ce-1', enabled: true, toolOverrides: null,
});

describe('Resilience + isolation (T012 — US3)', () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateCache(); });

  it('MCP down → turn completes with 0 brokered tools, health = degraded', async () => {
    mockListTools.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding()], [entry]);

    expect(result.tools).toHaveLength(0);
    expect(result.health).toHaveLength(1);
    expect(result.health[0].status).toBe('degraded');
    expect(result.health[0].entryName).toBe('flaky');
  });

  it('Second turn → cache hit (≤1 discovery / TTL window)', async () => {
    mockListTools.mockResolvedValue([{ name: 'tool1', description: 'T', inputSchema: {} }]);

    const bindings = [makeBinding()], entries = [entry];
    await buildBrokeredTools('tenant-1', 'persona-1', bindings, entries);
    await buildBrokeredTools('tenant-1', 'persona-1', bindings, entries);

    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('Cache invalidated by rescan → fresh discovery', async () => {
    mockListTools
      .mockResolvedValueOnce([{ name: 'tool1', description: 'T', inputSchema: {} }])
      .mockResolvedValueOnce([{ name: 'tool1', description: 'T-v2', inputSchema: {} }]);

    const bindings = [makeBinding()], entries = [entry];
    await buildBrokeredTools('tenant-1', 'persona-1', bindings, entries);
    invalidateCache('ce-1');
    await buildBrokeredTools('tenant-1', 'persona-1', bindings, entries);

    expect(mockListTools).toHaveBeenCalledTimes(2);
  });

  it('Partial failure: one entry up, one down → mixed health', async () => {
    const entryUp: McpCatalogEntryRow = { ...entry, id: 'ce-up', name: 'up' };
    const entryDown: McpCatalogEntryRow = { ...entry, id: 'ce-down', name: 'down' };
    const bindingUp: BindingRow = { ...makeBinding(), id: 'b-up', catalogEntryId: 'ce-up' };
    const bindingDown: BindingRow = { ...makeBinding(), id: 'b-down', catalogEntryId: 'ce-down' };

    mockListTools
      .mockResolvedValueOnce([{ name: 'tool', description: 'T', inputSchema: {} }])
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await buildBrokeredTools('tenant-1', 'persona-1', [bindingUp, bindingDown], [entryUp, entryDown]);

    expect(result.tools).toHaveLength(1);
    expect(result.health).toHaveLength(2);
    const healthMap = new Map(result.health.map(h => [h.entryName, h.status]));
    expect(healthMap.get('up')).toBe('reachable');
    expect(healthMap.get('down')).toBe('degraded');
  });

  it('Disabled binding → entry not discovered', async () => {
    const disabledBinding: BindingRow = { ...makeBinding(), enabled: false };
    const result = await buildBrokeredTools('tenant-1', 'persona-1', [disabledBinding], [entry]);

    expect(result.tools).toHaveLength(0);
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it('Disabled entry → not discovered', async () => {
    const disabledEntry: McpCatalogEntryRow = { ...entry, enabled: false };
    const result = await buildBrokeredTools('tenant-1', 'persona-1', [makeBinding()], [disabledEntry]);

    expect(result.tools).toHaveLength(0);
  });
});
