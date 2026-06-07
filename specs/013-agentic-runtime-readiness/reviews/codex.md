# SpecKit Review: 013-agentic-runtime-readiness

**Reviewer**: codex
**Reviewed at**: 2026-06-07T13:47:07.2924379Z
**Commit**: 9ba3c0c01acaec9317ef0636291684b2570c7545
**Artifacts reviewed**: spec.md, plan.md, tasks.md, research.md, data-model.md, quickstart.md, contracts/, checklists/requirements.md, reviews/context-for-review.md, .specify/memory/constitution.md

## Summary

The feature has a strong problem statement: Hermes runtime availability and Honcho v3 drift are real blockers, and the spec keeps memory fail-open while making degradation observable. The blocking weakness is scope translation: the planned work can provision Hermes and rewrite Honcho, but it does not guarantee that the live chat path ever invokes `HermesExecutor`, so the headline success criterion can still fail after all tasks are done.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Logical consistency | `spec.md:30-40` and `spec.md:95` require an agentic turn to complete end-to-end, but `tasks.md:40-43` only provisions the image/preflight and `tasks.md:59-60` only rewrites Honcho. There is no task that wires `turn-router`/`HermesExecutor.runAgentTurn` into the live chat API. Current repo context reinforces the gap: `packages/core/src/services/chat-service.ts:186-193` and `packages/core/src/services/chat-service.ts:366-372` still call `llm.complete` / `llm.completeStream`, while `specs/main/requirements.md:22` says the agentic executor is not yet wired. Completing T001-T014 can therefore still leave SC-001 false. | Add an explicit implementation and E2E task for the live request path: non-scripted `/v1/chat/completions` and stream calls route through `turn-router` to `HermesExecutor.runAgentTurn`, with fallback only on Hermes outage. If this wiring belongs to another feature, mark it as a blocking prerequisite and narrow SC-001 to runtime/preflight only. |
| F2 | CRITICAL | Constitution alignment | `plan.md:31-32` and `tasks.md:177` explicitly defer snapshot/commit, but the constitution requires every feature-artifact stage to tag the commit (`.specify/memory/constitution.md:62-70`). At HEAD, only `review/013-agentic-runtime-readiness/v1` exists; no `specify/`, `clarify/`, `plan/`, or `tasks/` tags exist for this slug. Per the review command's severity rule, a constitution violation is CRITICAL. | Either run the required stage snapshots for the commit(s) containing specify/clarify/plan/tasks artifacts, or amend the constitution/standing order so "no commit without consent" has an explicit non-conflicting artifact-versioning path. Do not proceed to implement with the artifact history in this ambiguous state. |
| F3 | HIGH | Grounding / task accuracy | The spec says there is "no engine Dockerfile" (`spec.md:12`) and the checklist repeats that `**/Dockerfile* -> none` (`checklists/requirements.md:17`), but the current repo has a tracked `packages/api/Dockerfile` (`packages/api/Dockerfile:1-38`). That existing file is `node:20-alpine` and lacks Python/pipx/Hermes, so the real task is not "NEW Dockerfile" (`tasks.md:40`) but "replace/update an existing engine image without regressing its workspace build." The stale premise can cause implementers to miss preservation of current build behavior or misdiagnose compose failures. | Update spec/checklist/tasks to say the existing engine Dockerfile must be converted from the current Node-only image to the Node+Python+Hermes image, preserving the current pnpm workspace build and entrypoint. Keep T004's build-time `hermes acp --check` assert. |
| F4 | HIGH | Hidden assumption | The preflight is "gated to the agentic path" (`contracts/hermes-runtime-preflight.contract.md:7`) and T006 says to gate it to "agentic-enabled deploys" (`tasks.md:42`), but the artifacts never define the enabling predicate or config source. If the compose deployment does not set that flag, the preflight can be skipped and a missing Hermes can still surface later; if the flag is inferred from existing personas, boot behavior becomes data-dependent. | Define a concrete enablement contract, e.g. `AGENTIC_EXECUTOR_ENABLED=true` in compose/host docs or an explicit runtime config check. Add tests for enabled+missing Hermes, enabled+compatible Hermes, and disabled+missing Hermes so FR-003 and AC4 are both deterministic. |
| F5 | HIGH | Failure modes / testability | The original Honcho bug is a permanent API drift hidden as no-op (`spec.md:14`, `spec.md:66`, `spec.md:79`), and the contract has AC4 for wrong/legacy API (`contracts/honcho-v3-client.contract.md:46`). But tasks only require the happy v3 contract test (`tasks.md:55`) and transient honcho-down integration (`tasks.md:56`); quickstart likewise only stops Honcho (`quickstart.md:41-47`). There is no required test that points the client at a legacy/no-`/v3` API and asserts a permanent readiness/health signal. | Add a RED-first test for permanent mismatch: mock or run a no-`/v3` endpoint, perform `getInsights`/`addMessage`, assert the turn remains fail-open, logs classify `permanent`, and `/v1/health` or the chosen metric exposes the mismatch. Pin the exact health field/metric name in the contract. |
| F6 | MEDIUM | Command parsing / preflight fidelity | `contracts/hermes-runtime-preflight.contract.md:11-15` says to split `HERMES_ACP_CMD` and then run `hermes acp --check`, while the existing executor uses whitespace splitting (`packages/core/src/services/hermes/hermes-executor.ts:92-95`). This can preflight a different command than the runtime actually spawns, especially for absolute paths, wrappers, Windows host paths, or quoted arguments. | Introduce one shared parser/normalizer for `HERMES_ACP_CMD`, reuse it in both `HermesExecutor` and preflight, and make the preflight check the configured executable rather than a hardcoded `hermes` binary. Include a quoted/absolute-path unit test. |
| F7 | MEDIUM | Performance / concurrency | The Honcho contract requires get-or-create workspace/peer/session before memory operations (`contracts/honcho-v3-client.contract.md:18-20`) but does not define caching or conflict handling. Concurrent first turns for the same tenant/persona can race on creation, and repeated turns can pay multiple Honcho setup calls before each write/read. | Specify idempotent create handling (`409`/already-exists -> GET/use existing) and a small in-process cache for resolved workspace/peer/session identities, bounded by tenant/persona/session keys. Add a concurrency test around first write for a new tenant. |

## Alternative approaches considered

- Treat this feature as "runtime dependency readiness" only, and explicitly depend on a separate "wire agentic path into ChatService" feature before claiming SC-001.
- Split health reporting into two explicit surfaces: `/v1/health.checks.hermes` for boot/readiness and `/v1/health.checks.honcho_memory` for fail-open memory degradation, with metrics as secondary telemetry.
- Use a container-oriented Python installer such as `uv` or a fixed `PIPX_BIN_DIR=/usr/local/bin` strategy instead of relying on default `pipx` user paths.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: codex
reviewed_at: 2026-06-07T13:47:07.2924379Z
commit: 9ba3c0c01acaec9317ef0636291684b2570c7545
critical_count: 2
high_count: 3
medium_count: 2
low_count: 0
```
