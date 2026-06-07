# Prompt Eval Harness

## How To Run

1. Apply migrations, including `drizzle/0006_eval_harness.sql`.
2. Add eval cases as JSON files in `eval-cases/`, or set `EVAL_CASES_PATH=/path/to/cases`.
3. Start the API with normal engine env: `DATABASE_URL`, `LLM_PROVIDER_URL`, `LLM_DEFAULT_MODEL`, `LLM_API_KEY`, `REDIS_URL` if needed.
4. Trigger a run:

```bash
curl -X POST http://localhost:8090/v1/evals/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Read results with `GET /v1/evals/runs` and `GET /v1/evals/runs/:id`.

For the UI:

```bash
cd eval-ui
pnpm install
EVAL_ENGINE_URL=http://localhost:8090 EVAL_ENGINE_TOKEN=$TOKEN EVAL_TENANT_ID=$TENANT_ID pnpm dev
```

## Design Decisions

Assertions handle stochastic output by checking properties, ranges, regexes, and a semantic-ish similarity score instead of exact responses. The similarity strategy is deterministic local token-vector cosine similarity. It is cheap and testable, but weaker than real embedding similarity: paraphrases can false-fail and token overlap can false-pass. The assertion shape intentionally matches an embedding scorer so a BGE/OpenAI embedding backend can replace it later.

Eval executions call `ChatService.complete()` with `isTestThread: true` and `source: "eval-harness"`. This still creates conversations, messages, and usage events because the chat service has no dry-run mode. The mitigation is explicit labeling, making eval traffic filterable without changing production chat semantics. A future stronger version should add a no-persist/dry-run option or a dedicated sandbox tenant.

The runner invokes `ChatService` in-process. That exercises the real chat path while avoiding network setup and route-registration coupling. HTTP would be closer to a full black-box integration test, but it would duplicate auth/transport concerns and make deterministic test injection noisier.

Eval cases live in version-controlled JSON fixtures; run results live in Postgres. Fixtures are better for reviewable prompt regression cases that evolve with code and prompts. Database storage is better for historical run output and UI queries.

## AI Usage

I used Codex as the implementation assistant: first to read the brief and repo architecture, then to draft `SPEC.md`, implement the vertical slice, and run/adjust tests. I corrected toward smaller scope, repository-native Drizzle/Fastify patterns, and deterministic tests without external LLM calls.

## With More Time

- Replace token-vector similarity with real embedding similarity using the existing embedding service.
- Add retries or pass-k-of-n policy for flaky LLM behavior.
- Add baseline comparison between runs.
- Add cleanup/reporting for eval-created conversations and usage events.

## Repo Notes

- `ChatService.complete()` cannot run without persistence today, so eval traffic is labeled rather than isolated by a true dry-run.
- In this checkout, Fastify middleware registered through `buildServer()` appears encapsulated away from sibling routes; eval routes therefore also accept `X-Tenant-ID` directly as a fallback.
- The UI is outside the pnpm workspace so engine builds do not require Next dependencies.
