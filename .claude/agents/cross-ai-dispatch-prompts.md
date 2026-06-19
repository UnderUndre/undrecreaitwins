# Cross-AI Task Dispatch Prompts (undrecreaitwins engine)

> Copy-paste these prompts into Gemini CLI, Codex Desktop, Copilot Chat, or Antigravity.
> Each prompt instructs the AI to spawn subagents for parallel task execution.
> Prompts are parameterized: replace `<SLUG>` and `<TASK_IDS>` with actual values.

---

## Universal preamble (prepend to every dispatch)

```
You are implementing tasks for the `undrecreaitwins` engine — a multi-tenant AI-twin backend.

REPO: TypeScript 5.x, Node 20, pnpm workspace monorepo.
STACK: Fastify 5.x (API), Drizzle ORM + PostgreSQL + pgvector, Redis/BullMQ, Langfuse, TEI sidecar (BGE-M3).
LOCATION: packages/core (business logic + models + services), packages/api (Fastify routes), packages/shared (types/errors).

CRITICAL PATTERNS:
1. ALL DB queries MUST be inside `withTenantContext(tenantId, fn)` — sets RLS session var.
2. Cross-package imports via `@undrecreaitwins/core/...` package exports (NEVER relative paths like `../../../core/src/`).
3. Services are singletons in `packages/core/src/services/index.ts`.
4. Fastify routes are `FastifyPluginAsync` plugins registered in `packages/api/src/server.ts`.
5. Shared internal auth via `packages/api/src/middleware/internal-auth.ts` preHandler (timingSafeEqual).
6. Shared quality types at `packages/core/src/types/quality-event.ts`.
7. Env vars read inline via `process.env` — missing critical vars → fail-open + log warning.
8. Outbound HTTP via `ssrfSafeFetch()` from `packages/core/src/services/llm-provider/ssrf-audit.ts`.
9. Migrations are review-only `.sql` files in `drizzle/` — NEVER execute without approval.
10. Shared operator text wrapping via `wrapOperatorText()` from `packages/core/src/services/prompt-safety.ts`.

BUILD/TEST:
- Type check: `pnpm --filter @undrecreaitwins/core exec tsc --noEmit`
- Run tests: `pnpm --filter @undrecreaitwins/core exec vitest run src/test/`
- Build: `pnpm --filter @undrecreaitwins/core run build` then `pnpm --filter @undrecreaitwins/api run build`

GUARDRAILS:
- No `as any` — use proper types or `unknown`.
- No `console.log()` in production code — use `console.warn`/`console.error` with structured context.
- No `catch (e) {}` — log and rethrow or return safe default.
- No `process.env.X || "fallback"` — throw or fail-open explicitly.
- Every new table gets RLS policy + `tenantId` column.
- Every new Fastify route that needs internal auth uses `internalAuth` preHandler.
- Operator-authored text (instructions, lessons) wrapped in `wrapOperatorText()`.

SPEC CONTEXT:
- Feature specs live in `specs/<NNN-feature-name>/` with spec.md, plan.md, tasks.md, data-model.md, contracts/.
- Read the feature's tasks.md for task IDs, descriptions, and dependencies.
- Read the feature's data-model.md for entity types and schema.
- Read the feature's contracts/ for API shapes and error models.
```

---

## Dispatch 1: Backend implementation tasks (T001–T0NN)

```
{ UNIVERSAL PREAMBLE }

You are dispatched as BACKEND-SPECIALIST for feature `<SLUG>`.

YOUR TASKS: <TASK_IDS> (e.g., T001, T002, T003)

INSTRUCTIONS:
1. Read `specs/<SLUG>/tasks.md` — find your task IDs, their descriptions, file paths, acceptance criteria.
2. Read `specs/<SLUG>/data-model.md` — understand entity types you'll implement.
3. Read `specs/<SLUG>/contracts/` — understand API shapes and error contracts.
4. Read `specs/<SLUG>/spec.md` FRs relevant to your tasks.

EXECUTION:
- Follow the dependency graph in tasks.md — tasks must execute in dependency order.
- For each task: read the acceptance criteria, implement the code, verify with `tsc --noEmit`.
- Create files at the EXACT paths specified in tasks.md.
- Use existing codebase patterns: read neighboring files to understand import style, error handling, naming.
- After ALL tasks: run `pnpm --filter @undrecreaitwins/core exec tsc --noEmit` — must be clean.

SPAWN SUBAGENTS for parallel work:
- If you have multiple independent tasks (no dependency between them), spawn subagents.
- Each subagent gets ONE task with full context (task description + relevant spec sections + file paths).
- Example: "Implement T002: Create product-client.ts. Read tasks.md T002 for spec. Read contracts/dar-pipeline-contract.md §1 for the HTTP pull contract. File: packages/core/src/services/correction-rules/product-client.ts. Use ssrfSafeFetch for HTTP. Acceptance: 304 returns null, 404 returns empty, network error throws."
- Wait for all subagents to complete, then verify tsc passes.

OUTPUT:
- Report each task ID as DONE/FAILED.
- List all files created/modified.
- Paste any tsc errors if present.
```

---

## Dispatch 2: Database/migration tasks

```
{ UNIVERSAL PREAMBLE }

You are dispatched as DATABASE-ARCHITECT for feature `<SLUG>`.

YOUR TASKS: <TASK_IDS>

INSTRUCTIONS:
1. Read `specs/<SLUG>/tasks.md` — find your DB task IDs.
2. Read `specs/<SLUG>/data-model.md` — full schema with column types, indexes, RLS policies.
3. Implement Drizzle models in `packages/core/src/models/` following existing patterns (read `feedback-memories.ts` or `annotations.ts` as reference).
4. Create migration SQL in `drizzle/00NN_<description>.sql` (review-only — do NOT execute).
5. Re-export new models from `packages/core/src/models/index.ts`.
6. If extending existing models (e.g., personas), MODIFY the existing file — add columns after the last field.

CRITICAL:
- pgvector: use `vector('column_name', 1024)` from `./types.js`.
- pgEnum: `pgEnum('name', ['value1', 'value2'])` from `drizzle-orm/pg-core`.
- Indexes: HNSW for vector columns (`USING hnsw (col vector_cosine_ops)`), btree for filter columns.
- RLS: EVERY new table gets `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY ... USING (tenant_id = current_setting('app.current_tenant', true))`.
- Migration SQL is review-only per Standing Order #5 — generate the file, do NOT run it.

SPAWN SUBAGENTS:
- If creating multiple independent tables (e.g., feedback_memories + conversation_feedback_states), spawn one subagent per table.
- Each subagent: create model file + update index.ts + add migration SQL section.
- Coordinate index.ts updates — second subagent waits for first to finish.

VERIFY:
- `pnpm --filter @undrecreaitwins/core exec tsc --noEmit` — models must compile.
- Migration SQL is syntactically valid (no execution).

OUTPUT:
- Report each table created, columns, indexes, RLS policy.
- List migration file path.
```

---

## Dispatch 3: Test tasks

```
{ UNIVERSAL PREAMBLE }

You are dispatched as TEST-ENGINEER for feature `<SLUG>`.

YOUR TASKS: <TASK_IDS>

INSTRUCTIONS:
1. Read `specs/<SLUG>/tasks.md` — find your test task IDs and acceptance criteria.
2. Read the SERVICE code being tested (e.g., `packages/core/src/services/correction-rules/dar-pipeline.ts`).
3. Read existing tests as patterns: `packages/core/src/test/validators/language-guard.test.ts`.

TEST PATTERNS:
- Mock LLMClient: `const mockLLM = { complete: vi.fn().mockResolvedValue({ content: 'NO', model: 'test', finishReason: 'stop', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) } as any;`
- Test pass/strip/block verdicts for validators.
- Test graceful degradation (service fails → returns empty/safe default, no throw).
- Test edge cases from spec.md §Edge Cases.
- Use `describe('ModuleName', () => { it('should ...', async () => { ... }) })` format.

SPAWN SUBAGENTS:
- If testing multiple independent modules (e.g., detectors + aggregator + re-validator), spawn one subagent per module.
- Each subagent gets: test file path, module being tested, test cases from tasks.md acceptance criteria.
- Example: "Write tests for regex-detector.ts + keyword-detector.ts. Test cases: pattern match triggers, no-match doesn't trigger, invalid regex handled gracefully. File: packages/core/src/test/correction-rules/detectors.test.ts."

VERIFY:
- `pnpm --filter @undrecreaitwins/core exec vitest run src/test/<your-test-dir>/` — all tests pass.
- `pnpm --filter @undrecreaitwins/core exec tsc --noEmit` — no type errors in test files.

OUTPUT:
- Report test count (passed/failed).
- List test files created.
```

---

## Dispatch 4: Full feature implementation (all phases)

```
{ UNIVERSAL PREAMBLE }

You are implementing feature `<SLUG>` — ALL phases.

PHASED EXECUTION (phases are sync barriers — complete each before starting next):

PHASE 1 (Foundation — DB + Types):
  Spawn DATABASE-ARCHITECT subagent for all [DB] tasks.
  Wait for completion. Verify: `tsc --noEmit` clean.

PHASE 2 (Services — Core Logic):
  Spawn BACKEND-SPECIALIST subagent for all [BE] service tasks (types, services, business logic).
  Wait for completion. Verify: `tsc --noEmit` clean.

PHASE 3 (Integration):
  Spawn BACKEND-SPECIALIST subagent for integration tasks (chat-service.ts modification, route registration).
  Wait for completion. Verify: `tsc --noEmit` clean + `pnpm --filter @undrecreaitwins/api run build` clean.

PHASE 4 (Tests):
  Spawn TEST-ENGINEER subagent for all [E2E] test tasks.
  Wait for completion. Verify: `vitest run` all pass.

RULES:
- Read `specs/<SLUG>/tasks.md` for exact task IDs, descriptions, dependencies, file paths.
- Follow dependency graph — tasks with unmet dependencies MUST wait.
- Each subagent gets: task description + relevant spec sections (FR/NFR) + file paths + acceptance criteria.
- After each phase, run the build/test verification before proceeding.
- Report progress after each phase: tasks completed, files created, verification status.

FINAL VERIFICATION:
  `pnpm --filter @undrecreaitwins/core exec tsc --noEmit`     # MUST pass
  `pnpm --filter @undrecreaitwins/core exec vitest run src/test/`  # MUST pass
  `pnpm --filter @undrecreaitwins/api run build`              # MUST pass
```

---

## Dispatch 5: Bug fix (targeted)

```
{ UNIVERSAL PREAMBLE }

You are dispatched as DEBUGGER to fix: <BUG_DESCRIPTION>.

INSTRUCTIONS:
1. Read the failing file(s) and understand the code flow.
2. Reproduce: run the failing test or command.
3. Isolate: identify the root cause (don't guess — follow the stack trace).
4. Fix: minimal change that addresses the root cause.
5. Verify: `pnpm --filter @undrecreaitwins/core exec tsc --noEmit` + relevant tests pass.

COMMON ENGINE BUGS:
- TS6059 rootDir error → relative cross-package import → change to @undrecreaitwins/core/... package export.
- Tenant data leak → missing withTenantContext() wrapper.
- Empty pgvector results → embedding dimension mismatch (must be 1024-dim, JSON.stringify format).
- Validator doesn't fire → wrong pipeline ordering or missing registration in pipeline.ts constructor.
- DAR pipeline no-op → missing TWIN_PRODUCT_API_URL/TWIN_PRODUCT_API_KEY env vars.
- LLM timeout → LLMClient.complete() has no signal param — use Promise.race with timeout.

SPAWN SUBAGENTS:
- If the bug spans multiple files/domains, spawn subagents to investigate in parallel.
- Example: "Investigate why feedback retrieval returns empty. Check feedback-retrieval.ts query, check withTenantContext usage, check feedback_memories model."
- Collect findings, then apply the fix yourself (single coordinated change).

OUTPUT:
- Root cause analysis (what + why).
- Files changed.
- Verification results.
```
