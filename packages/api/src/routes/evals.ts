import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EvalRepository } from '@undrecreaitwins/core/services/eval-repository.js';
import { EvalRunner } from '@undrecreaitwins/core/services/eval-runner.js';
import { UnauthorizedError, ValidationError } from '@undrecreaitwins/shared';
import type { EvalResultRow, EvalRunRow } from '@undrecreaitwins/core/services/eval-repository.js';

const repo = new EvalRepository();
const runner = new EvalRunner({ repository: repo });

const runBodySchema = z.object({
  case_names: z.array(z.string().min(1)).optional(),
});

function parsePaging(query: unknown): { limit: number; offset: number } {
  const queryRecord = query as Record<string, string | undefined>;
  const parsedLimit = Number(queryRecord.limit);
  const limit = !Number.isFinite(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
  const parsedOffset = Number(queryRecord.offset);
  const offset = !Number.isFinite(parsedOffset) ? 0 : Math.max(parsedOffset, 0);
  return { limit, offset };
}

function toApiRun(row: EvalRunRow) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
    total_cases: row.totalCases,
    passed_cases: row.passedCases,
  };
}

function toApiResult(row: EvalResultRow) {
  return {
    id: row.id,
    run_id: row.runId,
    case_name: row.caseName,
    passed: row.passed,
    response: row.response,
    assertion_results: row.assertionResults,
    created_at: row.createdAt.toISOString(),
  };
}

function resolveTenantId(request: { tenantId?: string; headers: Record<string, unknown> }): string {
  const headerTenantId = request.headers['x-tenant-id'];
  const tenantId = request.tenantId ?? (typeof headerTenantId === 'string' ? headerTenantId : undefined);
  if (!tenantId) {
    throw new UnauthorizedError('Missing tenant context');
  }
  return tenantId;
}

export const evalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/evals/runs', async (request) => {
    const tenantId = resolveTenantId(request);
    const { limit, offset } = parsePaging(request.query);
    const result = await repo.listRuns(tenantId, limit, offset);
    return {
      data: result.data.map((run) => toApiRun(run)),
      limit,
      offset,
      total: result.total,
    };
  });

  fastify.get('/v1/evals/runs/:id', async (request) => {
    const tenantId = resolveTenantId(request);
    const { id } = request.params as { id: string };
    const result = await repo.getRunWithResults(tenantId, id);
    return {
      ...toApiRun(result.run),
      results: result.results.map((row) => toApiResult(row)),
    };
  });

  fastify.post('/v1/evals/run', async (request, reply) => {
    const tenantId = resolveTenantId(request);
    const parseResult = runBodySchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const result = await runner.run(tenantId, parseResult.data.case_names);
    reply.status(201);
    return {
      ...toApiRun(result.run),
      results: result.results.map((row) => toApiResult(row)),
    };
  });
};
