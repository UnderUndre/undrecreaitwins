import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenantContext } from '../db.js';
import { evalResults, evalRuns } from '../models/index.js';
import { NotFoundError, ServiceUnavailableError } from '@undrecreaitwins/shared';
import type { EvalAssertionResult } from './eval-types.js';

export type EvalRunRow = typeof evalRuns.$inferSelect;
export type EvalResultRow = typeof evalResults.$inferSelect;

export type CreateEvalResultInput = {
  caseName: string;
  passed: boolean;
  response: string;
  assertionResults: EvalAssertionResult[];
};

export class EvalRepository {
  async createRun(tenantId: string, totalCases: number): Promise<EvalRunRow> {
    return withTenantContext(tenantId, async (tx) => {
      const [run] = await tx
        .insert(evalRuns)
        .values({
          tenantId,
          totalCases,
          passedCases: 0,
        })
        .returning();
      if (!run) {
        throw new ServiceUnavailableError('Database', 'Failed to create eval run');
      }
      return run;
    });
  }

  async finishRun(tenantId: string, runId: string, passedCases: number): Promise<EvalRunRow> {
    return withTenantContext(tenantId, async (tx) => {
      const [run] = await tx
        .update(evalRuns)
        .set({
          finishedAt: new Date(),
          passedCases,
        })
        .where(and(eq(evalRuns.id, runId), eq(evalRuns.tenantId, tenantId)))
        .returning();
      if (!run) {
        throw new NotFoundError('Eval run', runId);
      }
      return run;
    });
  }

  async insertResults(tenantId: string, runId: string, results: CreateEvalResultInput[]): Promise<EvalResultRow[]> {
    if (results.length === 0) {
      return [];
    }

    return withTenantContext(tenantId, async (tx) => tx
      .insert(evalResults)
      .values(results.map((result) => ({
        tenantId,
        runId,
        caseName: result.caseName,
        passed: result.passed,
        response: result.response,
        assertionResults: result.assertionResults,
      })))
      .returning());
  }

  async listRuns(
    tenantId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ data: EvalRunRow[]; total: number }> {
    return withTenantContext(tenantId, async (tx) => {
      const data = await tx
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.tenantId, tenantId))
        .orderBy(desc(evalRuns.startedAt))
        .limit(limit)
        .offset(offset);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(evalRuns)
        .where(eq(evalRuns.tenantId, tenantId));
      return { data, total: countRow?.count ?? 0 };
    });
  }

  async getRunWithResults(
    tenantId: string,
    runId: string,
  ): Promise<{ run: EvalRunRow; results: EvalResultRow[] }> {
    return withTenantContext(tenantId, async (tx) => {
      const [run] = await tx
        .select()
        .from(evalRuns)
        .where(and(eq(evalRuns.id, runId), eq(evalRuns.tenantId, tenantId)))
        .limit(1);
      if (!run) {
        throw new NotFoundError('Eval run', runId);
      }

      const results = await tx
        .select()
        .from(evalResults)
        .where(and(eq(evalResults.runId, runId), eq(evalResults.tenantId, tenantId)))
        .orderBy(evalResults.createdAt);

      return { run, results };
    });
  }
}
