import { withTenantContext } from '../../db.js';
import { actionAudit } from '../../models/index.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflictError, AppError, ForbiddenError } from '@undrecreaitwins/shared';

/** A persona's allow-listed tool entry (from persona.toolAllowlist jsonb). */
export interface ToolAllowEntry {
  id: string;
  isWrite?: boolean;
  requiresConfirmation?: boolean;
}

export interface ToolCallRequest {
  tenantId: string;
  personaId: string;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  isWriteAction: boolean;
  /** The calling persona's allow-list — the authoritative permission gate (H5). */
  allowlist: ToolAllowEntry[];
}

export interface ToolCallResult {
  success: boolean;
  result: unknown;
  auditId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isWriteAction: boolean;
  requiresConfirmation: boolean;
  handler: (args: Record<string, unknown>, context: { tenantId: string; personaId: string }) => Promise<unknown>;
}

const toolRegistry = new Map<string, ToolDefinition>();

const REDACT_PATTERNS = /^(token|password|secret|apiKey|authorization|key)$/i;
const MAX_ARGS_LENGTH = 64_000;

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    result[k] = REDACT_PATTERNS.test(k) ? 'REDACTED' : v;
  }
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_ARGS_LENGTH) {
    return { _truncated: true, _originalKeys: Object.keys(result) };
  }
  return result;
}

export function registerTool(def: ToolDefinition): void {
  toolRegistry.set(def.name, def);
}

export function getToolDefinitions(personaAllowlist: string[]): ToolDefinition[] {
  return personaAllowlist
    .map(name => toolRegistry.get(name))
    .filter((t): t is ToolDefinition => t !== undefined);
}

/**
 * Record a denied attempt (tenant-scoped, audit-only) and return the error to throw.
 * Uses a synthetic idempotency key so denied rows never collide with the live key space.
 */
async function auditDenied(call: ToolCallRequest, reason: string): Promise<ForbiddenError> {
  await withTenantContext(call.tenantId, async (tx) => {
    await tx.insert(actionAudit).values({
      id: randomUUID(),
      tenantId: call.tenantId,
      personaId: call.personaId,
      toolName: call.toolName,
      argsJson: JSON.stringify(redactArgs(call.args)),
      idempotencyKey: `denied-${randomUUID()}`,
      isWriteAction: call.isWriteAction,
      status: 'denied',
      errorMessage: reason,
    });
  });
  return new ForbiddenError(reason);
}

export async function executeTool(call: ToolCallRequest): Promise<ToolCallResult> {
  const tool = toolRegistry.get(call.toolName);
  if (!tool) {
    throw new AppError(`Tool not found: ${call.toolName}`, 404, 'tool_not_found');
  }

  // --- H5: allow-list + per-persona write-permission gate (before any execution) ---
  const entry = call.allowlist.find(e => e.id === call.toolName);
  if (!entry) {
    throw await auditDenied(call, `Tool ${call.toolName} is not in the persona allow-list`);
  }
  if (tool.isWriteAction && !entry.isWrite) {
    throw await auditDenied(call, `Tool ${call.toolName} is a write-action but the persona does not permit writes`);
  }

  const redactedArgs = redactArgs(call.args);

  // --- Read (non-write) tools: execute, then a single short audit txn ---
  if (!tool.isWriteAction) {
    const result = await tool.handler(call.args, { tenantId: call.tenantId, personaId: call.personaId });
    const auditId = await withTenantContext(call.tenantId, async (tx) => {
      const [audit] = await tx.insert(actionAudit).values({
        id: randomUUID(),
        tenantId: call.tenantId,
        personaId: call.personaId,
        toolName: call.toolName,
        argsJson: JSON.stringify(redactedArgs),
        resultJson: JSON.stringify(result),
        idempotencyKey: call.idempotencyKey,
        isWriteAction: false,
        status: 'ok',
      }).returning({ id: actionAudit.id });
      if (!audit) throw new AppError('Failed to audit tool call', 500, 'audit_insert_failed');
      return audit.id;
    });
    return { success: true, result, auditId };
  }

  // --- Write actions: reserve → execute → finalize, each in its OWN committed txn ---
  // The external side-effect runs OUTSIDE any DB transaction, so:
  //  - no Postgres connection is held during the (possibly slow) external call;
  //  - the 'pending' reserve is durable BEFORE the side-effect, so a crash leaves
  //    a sweepable orphan instead of allowing a retry to re-execute (FR-012 / claude F2).

  // Step 1 — reserve a 'pending' row in its own committed transaction.
  const reservation = await withTenantContext(call.tenantId, async (tx) => {
    const [reserved] = await tx.insert(actionAudit).values({
      id: randomUUID(),
      tenantId: call.tenantId,
      personaId: call.personaId,
      toolName: call.toolName,
      argsJson: JSON.stringify(redactedArgs),
      idempotencyKey: call.idempotencyKey,
      isWriteAction: true,
      status: 'pending',
    }).onConflictDoNothing({ target: [actionAudit.tenantId, actionAudit.idempotencyKey] })
      .returning({ id: actionAudit.id });

    if (reserved) {
      return { kind: 'reserved' as const, id: reserved.id };
    }

    // Conflict — a row with this key already exists. Read its terminal state.
    const [existing] = await tx.select({
      id: actionAudit.id,
      resultJson: actionAudit.resultJson,
      status: actionAudit.status,
    })
      .from(actionAudit)
      .where(and(eq(actionAudit.tenantId, call.tenantId), eq(actionAudit.idempotencyKey, call.idempotencyKey)))
      .limit(1);

    if (!existing) {
      throw new AppError('Idempotency conflict but no existing row found', 500, 'idempotency_race');
    }
    return { kind: 'conflict' as const, existing };
  });

  if (reservation.kind === 'conflict') {
    const existing = reservation.existing;
    if (existing.status === 'ok' || existing.status === 'failed') {
      // Terminal — replay the stored result, never re-execute.
      return {
        success: existing.status === 'ok',
        result: JSON.parse(existing.resultJson || 'null'),
        auditId: existing.id,
      };
    }
    // Still 'pending' (in-flight or crashed-and-awaiting-sweep) — do NOT re-execute.
    throw new ConflictError(`Tool call ${call.idempotencyKey} is already in flight`);
  }

  // Step 2 — reserve is committed. Execute the handler OUTSIDE any transaction.
  const reservedId = reservation.id;
  let result: unknown;
  try {
    result = await tool.handler(call.args, { tenantId: call.tenantId, personaId: call.personaId });
  } catch (err) {
    // Step 3a — finalize 'failed' in a separate txn.
    await withTenantContext(call.tenantId, async (tx) => {
      await tx.update(actionAudit)
        .set({ status: 'failed', errorMessage: err instanceof Error ? err.message : String(err) })
        .where(eq(actionAudit.id, reservedId));
    });
    throw err;
  }

  // Step 3b — finalize 'ok' with the result in a separate txn.
  await withTenantContext(call.tenantId, async (tx) => {
    await tx.update(actionAudit)
      .set({ status: 'ok', resultJson: JSON.stringify(result) })
      .where(eq(actionAudit.id, reservedId));
  });

  return { success: true, result, auditId: reservedId };
}
