import pino from 'pino';
import { mcpListTools, mcpCallTool, type McpCatalogEntryRow, type DiscoveredTool, McpClientError } from './mcp-client.js';
import type { ToolDefinition } from './tool-gateway.js';

const logger = pino({ name: 'mcp-broker' });

export interface BindingRow {
  id: string;
  tenantId: string;
  personaId: string;
  catalogEntryId: string;
  enabled: boolean;
  toolOverrides: Array<{
    name: string;
    include?: boolean;
    isWrite?: boolean;
    requiresConfirmation?: boolean;
  }> | null;
}

export interface BrokerHealth {
  entryId: string;
  entryName: string;
  status: 'reachable' | 'degraded';
  reason?: string;
  toolCount: number;
}

export interface BrokerResult {
  tools: ToolDefinition[];
  allowlistEntries: Array<{ id: string; isWrite: boolean; requiresConfirmation: boolean }>;
  health: BrokerHealth[];
}

interface CacheEntry {
  tools: DiscoveredTool[];
  fetchedAt: number;
}

const discoveryCache = new Map<string, CacheEntry>();
const DISCOVERY_TTL_MS = 300_000;

export function invalidateCache(entryId?: string): void {
  if (entryId) {
    discoveryCache.delete(entryId);
  } else {
    discoveryCache.clear();
  }
}

function filterTools(
  tools: DiscoveredTool[],
  serverInclude: string[] | null,
  serverExclude: string[] | null,
  bindingOverrides: BindingRow['toolOverrides'],
): Array<{ tool: DiscoveredTool; isWrite: boolean; requiresConfirmation: boolean }> {
  const overrideMap = new Map(
    (bindingOverrides ?? []).map(o => [o.name, o]),
  );

  return tools
    .filter(t => {
      if (serverExclude?.includes(t.name)) return false;
      if (serverInclude && serverInclude.length > 0 && !serverInclude.includes(t.name)) return false;
      const ovr = overrideMap.get(t.name);
      if (ovr && ovr.include === false) return false;
      return true;
    })
    .map(t => {
      const ovr = overrideMap.get(t.name);
      const isWrite = ovr?.isWrite ?? true;
      const requiresConfirmation = ovr?.requiresConfirmation ?? (isWrite ? true : false);
      return { tool: t, isWrite, requiresConfirmation };
    });
}

export async function buildBrokeredTools(
  _tenantId: string,
  _personaId: string,
  bindings: BindingRow[],
  catalogEntries: McpCatalogEntryRow[],
): Promise<BrokerResult> {
  const entryMap = new Map(catalogEntries.map(e => [e.id, e]));
  const enabledBindings = bindings.filter(b => b.enabled);
  const tools: ToolDefinition[] = [];
  const allowlistEntries: Array<{ id: string; isWrite: boolean; requiresConfirmation: boolean }> = [];
  const health: BrokerHealth[] = [];

  const discoveryPromises = enabledBindings.map(async (binding): Promise<{
    binding: BindingRow;
    entry: McpCatalogEntryRow;
    discovered: DiscoveredTool[];
    ok: boolean;
    error?: string;
  }> => {
    const entry = entryMap.get(binding.catalogEntryId);
    if (!entry || !entry.enabled) {
      return { binding, entry: entry!, discovered: [], ok: false, error: 'Entry not found or disabled' };
    }

    const cached = discoveryCache.get(entry.id);
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
      return { binding, entry, discovered: cached.tools, ok: true };
    }

    try {
      const discovered = await mcpListTools(entry);
      discoveryCache.set(entry.id, { tools: discovered, fetchedAt: Date.now() });
      return { binding, entry, discovered, ok: true };
    } catch (err) {
      const msg = err instanceof McpClientError ? err.message : String(err);
      logger.warn({ entryId: entry.id, entryName: entry.name, err: msg }, 'MCP discovery failed — degrading');
      return { binding, entry, discovered: [], ok: false, error: msg };
    }
  });

  const results = await Promise.allSettled(discoveryPromises);

  for (const settled of results) {
    if (settled.status === 'rejected') {
      logger.warn({ err: settled.reason }, 'Discovery promise rejected');
      continue;
    }

    const { binding, entry, discovered, ok, error } = settled.value;
    if (!entry) continue;

    if (!ok) {
      health.push({
        entryId: entry.id,
        entryName: entry.name,
        status: 'degraded',
        reason: error,
        toolCount: 0,
      });
      continue;
    }

    const filtered = filterTools(
      discovered,
      entry.toolsInclude,
      entry.toolsExclude,
      binding.toolOverrides,
    );

    health.push({
      entryId: entry.id,
      entryName: entry.name,
      status: 'reachable',
      toolCount: filtered.length,
    });

    for (const { tool, isWrite, requiresConfirmation } of filtered) {
      const namespacedName = `mcp_${entry.name}_${tool.name}`;
      const def: ToolDefinition = {
        name: namespacedName,
        description: tool.description,
        parameters: tool.inputSchema,
        isWriteAction: isWrite,
        requiresConfirmation,
        handler: async (args, _ctx) => {
          const callResult = await mcpCallTool(entry, tool.name, args);
          const text = callResult.content
            .map(c => c.text ?? JSON.stringify(c))
            .join('\n');
          return `<untrusted_tool_result>\n${text}\n</untrusted_tool_result>`;
        },
      };
      tools.push(def);
      allowlistEntries.push({ id: namespacedName, isWrite, requiresConfirmation });
    }
  }

  return { tools, allowlistEntries, health };
}
