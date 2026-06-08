import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { mcpCatalogEntry, assistantMcpBinding } from '@undrecreaitwins/core/models/index.js';

type CatalogRow = typeof mcpCatalogEntry.$inferSelect;
type BindingRow = typeof assistantMcpBinding.$inferSelect;
import { encryptApiKey, assertUrlAllowed } from '@undrecreaitwins/core/services/llm-provider/index.js';
import { mcpListTools, type McpCatalogEntryRow } from '@undrecreaitwins/core/services/hermes/mcp-client.js';
import { invalidateCache } from '@undrecreaitwins/core/services/hermes/mcp-broker.js';
import { ValidationError, NotFoundError } from '@undrecreaitwins/shared';
import { eq } from 'drizzle-orm';

const ENTRY_NAME_RE = /^[a-z0-9_-]+$/;
const ENTRY_NAME_MAX = 20;

const createEntrySchema = z.object({
  name: z.string().max(ENTRY_NAME_MAX).regex(ENTRY_NAME_RE, 'name must match ^[a-z0-9_-]+$'),
  transport: z.enum(['http', 'stdio']).default('http'),
  url: z.string().url().optional(),
  command: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  auth: z.record(z.string()).optional(),
  tools_include: z.array(z.string()).optional(),
  tools_exclude: z.array(z.string()).optional(),
  timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  tls_verify: z.boolean().default(true),
});

const patchEntrySchema = z.object({
  name: z.string().max(ENTRY_NAME_MAX).regex(ENTRY_NAME_RE).optional(),
  url: z.string().url().optional(),
  command: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  auth: z.record(z.string()).optional(),
  tools_include: z.array(z.string()).nullable().optional(),
  tools_exclude: z.array(z.string()).nullable().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
  tls_verify: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const putBindingsSchema = z.object({
  bindings: z.array(z.object({
    catalog_entry_id: z.string().uuid(),
    enabled: z.boolean().default(true),
    tool_overrides: z.array(z.object({
      name: z.string(),
      include: z.boolean().optional(),
      isWrite: z.boolean().optional(),
      requiresConfirmation: z.boolean().optional(),
    })).default([]),
  })),
});

function toRow(row: unknown): McpCatalogEntryRow {
  const r = row as CatalogRow;
  return {
    id: r.id as string,
    tenantId: r.tenantId as string,
    scope: (r.scope as string) as 'tenant' | 'platform',
    name: r.name as string,
    transport: (r.transport as string) as 'http' | 'stdio',
    url: (r.url as string) ?? null,
    command: (r.command as string) ?? null,
    args: (r.args as unknown[]) ?? null,
    authCiphertext: (r.authCiphertext as string) ?? null,
    authRef: (r.authRef as string) ?? null,
    toolsInclude: (r.toolsInclude as string[]) ?? null,
    toolsExclude: (r.toolsExclude as string[]) ?? null,
    timeoutMs: (r.timeoutMs as number) ?? 30000,
    tlsVerify: (r.tlsVerify as boolean) ?? true,
    enabled: (r.enabled as boolean) ?? true,
  };
}

function sanitize(entry: CatalogRow): Record<string, unknown> {
  return {
    id: entry.id,
    tenant_id: entry.tenantId,
    scope: entry.scope,
    name: entry.name,
    transport: entry.transport,
    url: entry.url,
    has_auth: !!(entry.authCiphertext),
    tools_include: entry.toolsInclude,
    tools_exclude: entry.toolsExclude,
    timeout_ms: entry.timeoutMs,
    tls_verify: entry.tlsVerify,
    enabled: entry.enabled,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

export const mcpCatalogRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /v1/mcp/health ────────────────────────────────────────────────

  fastify.get('/v1/mcp/health', async (_request) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ── GET /v1/mcp/catalog ───────────────────────────────────────────────

  fastify.get('/v1/mcp/catalog', async (request) => {
    return withTenantContext(request.tenantId, async (tx) => {
      const rows = await tx.select().from(mcpCatalogEntry);
      return { data: rows.map(r => sanitize(r)) };
    });
  });

  // ── POST /v1/mcp/catalog ──────────────────────────────────────────────

  fastify.post('/v1/mcp/catalog', async (request, reply) => {
    const parsed = createEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
      );
    }
    const body = parsed.data;

    if (body.transport === 'stdio') {
      throw new ValidationError([{ field: 'transport', message: 'stdio transport is only available for platform-admin entries' }]);
    }

    if (!body.url) {
      throw new ValidationError([{ field: 'url', message: 'url is required for http transport' }]);
    }

    const ssrf = await assertUrlAllowed(body.url);
    if (!ssrf.allowed) {
      throw new ValidationError([{ field: 'url', message: `SSRF-blocked: ${ssrf.reason}` }]);
    }

    let authCiphertext: string | null = null;
    let authRef: string | null = null;
    if (body.auth && Object.keys(body.auth).length > 0) {
      const encrypted = await encryptApiKey(JSON.stringify(body.auth));
      authCiphertext = encrypted.ciphertext;
      authRef = encrypted.keyRef;
    }

    const [row] = await withTenantContext(request.tenantId, async (tx) => {
      return tx.insert(mcpCatalogEntry).values({
        tenantId: request.tenantId,
        name: body.name,
        transport: body.transport,
        url: body.url,
        toolsInclude: body.tools_include ?? null,
        toolsExclude: body.tools_exclude ?? null,
        timeoutMs: body.timeout_ms,
        tlsVerify: body.tls_verify,
        authCiphertext,
        authRef,
      }).returning();
    }) as [CatalogRow];

    reply.status(201);
    return sanitize(row);
  });

  // ── PATCH /v1/mcp/catalog/:id ─────────────────────────────────────────

  fastify.patch('/v1/mcp/catalog/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = patchEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
      );
    }
    const body = parsed.data;

    if (body.url) {
      const ssrf = await assertUrlAllowed(body.url);
      if (!ssrf.allowed) {
        throw new ValidationError([{ field: 'url', message: `SSRF-blocked: ${ssrf.reason}` }]);
      }
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.url !== undefined) updateData.url = body.url;
    if (body.timeout_ms !== undefined) updateData.timeoutMs = body.timeout_ms;
    if (body.tls_verify !== undefined) updateData.tlsVerify = body.tls_verify;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.tools_include !== undefined) updateData.toolsInclude = body.tools_include;
    if (body.tools_exclude !== undefined) updateData.toolsExclude = body.tools_exclude;

    if (body.auth && Object.keys(body.auth).length > 0) {
      const encrypted = await encryptApiKey(JSON.stringify(body.auth));
      updateData.authCiphertext = encrypted.ciphertext;
      updateData.authRef = encrypted.keyRef;
    }

    const [row] = await withTenantContext(request.tenantId, async (tx) => {
      const [updated] = await tx.update(mcpCatalogEntry)
        .set(updateData)
        .where(eq(mcpCatalogEntry.id, id))
        .returning();
      if (!updated) throw new NotFoundError('McpCatalogEntry', id);
      return [updated];
    });

    invalidateCache(id);
    return sanitize(row);
  });

  // ── DELETE /v1/mcp/catalog/:id ────────────────────────────────────────

  fastify.delete('/v1/mcp/catalog/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await withTenantContext(request.tenantId, async (tx) => {
      const [deleted] = await tx.delete(mcpCatalogEntry)
        .where(eq(mcpCatalogEntry.id, id))
        .returning({ id: mcpCatalogEntry.id });
      if (!deleted) throw new NotFoundError('McpCatalogEntry', id);
    });
    invalidateCache(id);
    reply.status(204);
  });

  // ── POST /v1/mcp/catalog/:id/rescan ───────────────────────────────────

  fastify.post('/v1/mcp/catalog/:id/rescan', async (request) => {
    const { id } = request.params as { id: string };
    invalidateCache(id);

    const row = await withTenantContext(request.tenantId, async (tx) => {
      const [entry] = await tx.select().from(mcpCatalogEntry).where(eq(mcpCatalogEntry.id, id));
      if (!entry) throw new NotFoundError('McpCatalogEntry', id);
      return entry;
    });

    const entryRow = toRow(row);
    const tools = await mcpListTools(entryRow);

    return {
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // ── GET /v1/assistants/:personaId/mcp ─────────────────────────────────

  fastify.get('/v1/assistants/:personaId/mcp', async (request) => {
    const { personaId } = request.params as { personaId: string };
    return withTenantContext(request.tenantId, async (tx) => {
      const rows = await tx.select().from(assistantMcpBinding)
        .where(eq(assistantMcpBinding.personaId, personaId));
      return {
        bindings: rows.map((r: BindingRow) => ({
          id: r.id,
          catalog_entry_id: r.catalogEntryId,
          enabled: r.enabled,
          tool_overrides: r.toolOverrides,
        })),
      };
    });
  });

  // ── PUT /v1/assistants/:personaId/mcp ─────────────────────────────────

  fastify.put('/v1/assistants/:personaId/mcp', async (request) => {
    const { personaId } = request.params as { personaId: string };
    const parsed = putBindingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
      );
    }
    const body = parsed.data;

    return withTenantContext(request.tenantId, async (tx) => {
      await tx.delete(assistantMcpBinding)
        .where(eq(assistantMcpBinding.personaId, personaId));

      const inserted = [];
      for (const b of body.bindings) {
        const [row] = await tx.insert(assistantMcpBinding).values({
          tenantId: request.tenantId,
          personaId,
          catalogEntryId: b.catalog_entry_id,
          enabled: b.enabled,
          toolOverrides: b.tool_overrides,
        }).returning();
        if (row) inserted.push(row);
      }

      return {
        bindings: inserted.map((r: BindingRow) => ({
          id: r.id,
          catalog_entry_id: r.catalogEntryId,
          enabled: r.enabled,
          tool_overrides: r.toolOverrides,
        })),
      };
    });
  });
};
