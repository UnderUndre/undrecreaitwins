import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export type EvalAssertionResult = {
  type: string;
  passed: boolean;
  message: string;
  score?: number;
  threshold?: number;
};

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    totalCases: integer('total_cases').notNull(),
    passedCases: integer('passed_cases').notNull().default(0),
  },
  (table) => ({
    tenantStartedIdx: index('eval_runs_tenant_started_idx').on(table.tenantId, table.startedAt),
  }),
);

export const evalResults = pgTable(
  'eval_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    runId: uuid('run_id').notNull().references(() => evalRuns.id),
    caseName: text('case_name').notNull(),
    passed: boolean('passed').notNull(),
    response: text('response').notNull(),
    assertionResults: jsonb('assertion_results').notNull().$type<EvalAssertionResult[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index('eval_results_run_idx').on(table.runId),
    tenantRunIdx: index('eval_results_tenant_run_idx').on(table.tenantId, table.runId),
  }),
);
