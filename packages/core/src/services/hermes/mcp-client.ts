import { assertUrlAllowed, ssrfSafeFetch } from '../llm-provider/index.js';
import { decryptApiKey } from '../llm-provider/index.js';

export interface McpCatalogEntryRow {
  id: string;
  tenantId: string;
  scope: 'tenant' | 'platform';
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: unknown[] | null;
  authCiphertext: string | null;
  authRef: string | null;
  toolsInclude: string[] | null;
  toolsExclude: string[] | null;
  timeoutMs: number;
  tlsVerify: boolean;
  enabled: boolean;
}

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class McpClientError extends Error {
  public readonly name = 'McpClientError';
  constructor(
    message: string,
    public readonly entryId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, McpClientError.prototype);
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;

export async function mcpConnect(entry: McpCatalogEntryRow): Promise<void> {
  if (entry.transport !== 'http' || !entry.url) {
    throw new McpClientError('Only HTTP transport supported for tenant entries', entry.id);
  }
  const ssrf = await assertUrlAllowed(entry.url);
  if (!ssrf.allowed) {
    throw new McpClientError(`SSRF-blocked: ${ssrf.reason}`, entry.id);
  }
}

export async function mcpListTools(entry: McpCatalogEntryRow): Promise<DiscoveredTool[]> {
  if (!entry.url) throw new McpClientError('No URL configured', entry.id);

  const ssrf = await assertUrlAllowed(entry.url);
  if (!ssrf.allowed) {
    throw new McpClientError(`SSRF-blocked at connect: ${ssrf.reason}`, entry.id);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (entry.authCiphertext && entry.authRef) {
    const plaintext = await decryptApiKey(entry.authCiphertext, entry.authRef);
    const parsed = JSON.parse(plaintext) as Record<string, string>;
    Object.assign(headers, parsed);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), entry.timeoutMs);

  try {
    const response = await ssrfSafeFetch(entry.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
      signal: controller.signal,
      ssrfTimeoutMs: entry.timeoutMs,
    });

    if (!response.ok) {
      throw new McpClientError(`tools/list returned ${response.status}`, entry.id);
    }

    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new McpClientError('Response exceeds max payload size', entry.id);
    }

    const json = JSON.parse(raw) as {
      result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
      error?: { message: string };
    };

    if (json.error) {
      throw new McpClientError(`tools/list error: ${json.error.message}`, entry.id);
    }

    return (json.result?.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
    }));
  } catch (err) {
    if (err instanceof McpClientError) throw err;
    throw new McpClientError(`tools/list failed: ${err instanceof Error ? err.message : String(err)}`, entry.id, err);
  } finally {
    clearTimeout(timer);
  }
}

export async function mcpCallTool(
  entry: McpCatalogEntryRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!entry.url) throw new McpClientError('No URL configured', entry.id);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (entry.authCiphertext && entry.authRef) {
    const plaintext = await decryptApiKey(entry.authCiphertext, entry.authRef);
    const parsed = JSON.parse(plaintext) as Record<string, string>;
    Object.assign(headers, parsed);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), entry.timeoutMs);

  try {
    const response = await ssrfSafeFetch(entry.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
      ssrfTimeoutMs: entry.timeoutMs,
    });

    if (!response.ok) {
      throw new McpClientError(`tools/call returned ${response.status}`, entry.id);
    }

    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new McpClientError('Response exceeds max payload size', entry.id);
    }

    const json = JSON.parse(raw) as {
      result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      error?: { message: string };
    };

    if (json.error) {
      throw new McpClientError(`tools/call error: ${json.error.message}`, entry.id);
    }

    return {
      content: json.result?.content ?? [{ type: 'text', text: JSON.stringify(json.result) }],
      isError: json.result?.isError,
    };
  } catch (err) {
    if (err instanceof McpClientError) throw err;
    throw new McpClientError(`tools/call failed: ${err instanceof Error ? err.message : String(err)}`, entry.id, err);
  } finally {
    clearTimeout(timer);
  }
}
