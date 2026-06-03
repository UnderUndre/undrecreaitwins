import { pgTable, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: text('persona_id').notNull(),
    conversationId: text('conversation_id'),
    kind: text('kind').notNull().default('agentic'),
    status: text('status').notNull().default('running'),
    inputPreview: text('input_preview'),
    outputPreview: text('output_preview'),
    stepsJson: jsonb('steps_json'),
    usageJson: jsonb('usage_json'),
    loopIterations: integer('loop_iterations').default(0),
    tokensUsed: integer('tokens_used').default(0),
    errorMessage: text('error_message'),
    routingDecision: text('routing_decision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    tenantIdx: index('agent_runs_tenant_idx').on(table.tenantId),
    personaIdx: index('agent_runs_persona_idx').on(table.personaId),
    createdAtIdx: index('agent_runs_created_at_idx').on(table.createdAt),
  }),
);

