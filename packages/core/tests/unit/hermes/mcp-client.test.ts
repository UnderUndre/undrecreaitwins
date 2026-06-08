import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAssertUrl, mockDecrypt, mockFetch } = vi.hoisted(() => ({
  mockAssertUrl: vi.fn().mockResolvedValue({ allowed: true, pinnedIp: '93.184.216.34' }),
  mockDecrypt: vi.fn().mockResolvedValue(JSON.stringify({ Authorization: 'Bearer testkey' })),
  mockFetch: vi.fn(),
}));

vi.mock('../../../src/services/llm-provider/index.js', () => ({
  assertUrlAllowed: mockAssertUrl,
  decryptApiKey: mockDecrypt,
  ssrfSafeFetch: mockFetch,
}));

import { mcpListTools, mcpCallTool, McpClientError } from '../../../src/services/hermes/mcp-client.js';

const mockEntry = {
  id: 'ce-1', tenantId: 'tenant-a', scope: 'tenant' as const, name: 'gh',
  transport: 'http' as const, url: 'https://mcp.example.com', command: null, args: null,
  authCiphertext: 'enc', authRef: 'ref', toolsInclude: null, toolsExclude: null,
  timeoutMs: 30000, tlsVerify: true, enabled: true,
};

describe('mcp-client (T008)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mcpListTools — returns discovered tools from JSON-RPC response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        result: { tools: [
          { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object' } },
          { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
        ]},
      }),
    });

    const tools = await mcpListTools(mockEntry);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('create_issue');
    expect(tools[1].name).toBe('list_issues');
  });

  it('mcpListTools — decrypts auth for request headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ result: { tools: [] } }),
    });

    await mcpListTools(mockEntry);
    expect(mockDecrypt).toHaveBeenCalledWith('enc', 'ref');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('tools/list');
  });

  it('mcpListTools — throws McpClientError on SSRF block', async () => {
    mockAssertUrl.mockResolvedValueOnce({ allowed: false, reason: 'private IP 127.0.0.1' });

    await expect(mcpListTools(mockEntry)).rejects.toThrow('SSRF-blocked');
  });

  it('mcpListTools — throws on oversized response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'x'.repeat(1_048_577),
    });

    await expect(mcpListTools(mockEntry)).rejects.toThrow('max payload');
  });

  it('mcpCallTool — returns content from JSON-RPC response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        result: { content: [{ type: 'text', text: '{"issue_id": 42}' }] },
      }),
    });

    const result = await mcpCallTool(mockEntry, 'create_issue', { title: 'Bug' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('{"issue_id": 42}');
  });

  it('mcpCallTool — sends tools/call method in body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: 'ok' }] } }),
    });

    await mcpCallTool(mockEntry, 'echo', {});
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('echo');
  });
});
