# Prompt Eval Harness Spec

## Scope

Build a minimal prompt regression harness for the engine. Eval cases live as version-controlled JSON fixtures with `name`, `personaSlug`, `messages`, and `assertions`. A core `EvalRunner` executes cases in-process through `ChatService.complete()`, evaluates structural assertions plus one semantic similarity assertion, and persists run summaries plus per-case results in Drizzle tables. The API exposes run listing/detail and a small run trigger. A portable Next.js/Tailwind UI lists runs and shows case-level details through an isolated fetch client.

## Acceptance Criteria

- Eval case fixtures can be loaded and validated without external services.
- Runner executes selected/all fixture cases for the request tenant and stores `eval_runs` and `eval_results`.
- Assertions supported: `contains`, `not_contains`, `regex`, `min_length`, `max_length`, and semantic `similarity`.
- API supports `GET /v1/evals/runs`, `GET /v1/evals/runs/:id`, and `POST /v1/evals/run`, registered from `buildServer()`.
- Results include case name, pass/fail, assistant response, and detailed assertion results.
- Tests use Vitest, `buildServer()`, `server.inject()`, and deterministic mocks; no external LLM calls.
- UI has a runs page and run detail page using HTTP fetch with bearer token and `X-Tenant-ID`.

## Assumptions

- This slice is tenant-scoped but not an admin/auth redesign; existing middleware remains authoritative.
- Eval executions may create conversations/messages/usage events because `ChatService.complete()` has no dry-run mode; they are marked as test traffic with `isTestThread: true` and `source: "eval-harness"`.
- Fixture cases are sufficient for regression coverage because they are small, reviewable, and versioned with prompt changes.
- The semantic strategy can be deterministic lexical similarity for tests and early regression use; production-grade embedding similarity can replace the scorer behind the same assertion shape.

## Resolved Ambiguities

- Runner is in-process, not HTTP, to exercise real chat behavior without depending on route registration or network setup.
- Case storage is files only; run/result storage is database only.
- The trigger endpoint is included because it completes the API/UI vertical slice.
- No streaming, baselines, retries, or flaky-run policy in this first version.
