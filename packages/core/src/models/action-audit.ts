import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';

export const actionAudit = pgTable(
  'action_audit',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: text('persona_id').notNull(),
    toolName: text('tool_name').notNull(),
    argsJson: text('args_json'),
    resultJson: text('result_json'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    isWriteAction: boolean('is_write_action').notNull().default(false),
    status: text('status').notNull().default('ok'), // pending, ok, failed, abandoned, denied, dry_run
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sweepIdx: index('action_audit_sweep_idx').on(table.status, table.createdAt),
    tenantIdx: index('action_audit_tenant_idx').on(table.tenantId),
  }),
);
