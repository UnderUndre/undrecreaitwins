import { db } from '../../db.js';
import { actionAudit } from '../../models/index.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

export interface ToolCallRequest {
  tenantId: string;
  personaId: string;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  isWriteAction: boolean;
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

export function registerTool(def: ToolDefinition): void {
  toolRegistry.set(def.name, def);
}

export function getToolDefinitions(personaAllowlist: string[]): ToolDefinition[] {
  return personaAllowlist
    .map(name => toolRegistry.get(name))
    .filter((t): t is ToolDefinition => t !== undefined);
}

export async function executeTool(call: ToolCallRequest): Promise<ToolCallResult> {
  const tool = toolRegistry.get(call.toolName);
  if (!tool) {
    throw new Error(`Tool not found: ${call.toolName}`);
  }

  if (!tool.isWriteAction) {
    const result = await tool.handler(call.args, { tenantId: call.tenantId, personaId: call.personaId });
    const [audit] = await db.insert(actionAudit).values({
      id: randomUUID(),
      tenantId: call.tenantId,
      personaId: call.personaId,
      toolName: call.toolName,
      argsJson: JSON.stringify(call.args),
      resultJson: JSON.stringify(result),
      idempotencyKey: call.idempotencyKey,
      isWriteAction: false,
    }).returning({ id: actionAudit.id });

    if (!audit) throw new Error('Failed to audit tool call');
    return { success: true, result, auditId: audit.id };
  }

  const [existing] = await db.select({ id: actionAudit.id, resultJson: actionAudit.resultJson })
    .from(actionAudit)
    .where(eq(actionAudit.idempotencyKey, call.idempotencyKey))
    .limit(1);

  if (existing) {
    return { success: true, result: JSON.parse(existing.resultJson || 'null'), auditId: existing.id };
  }

  const result = await tool.handler(call.args, { tenantId: call.tenantId, personaId: call.personaId });

  const [audit] = await db.insert(actionAudit).values({
    id: randomUUID(),
    tenantId: call.tenantId,
    personaId: call.personaId,
    toolName: call.toolName,
    argsJson: JSON.stringify(call.args),
    resultJson: JSON.stringify(result),
    idempotencyKey: call.idempotencyKey,
    isWriteAction: true,
  }).returning({ id: actionAudit.id });

  if (!audit) throw new Error('Failed to audit tool call');
  return { success: true, result, auditId: audit.id };
}
