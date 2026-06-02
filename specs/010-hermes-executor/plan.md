# Implementation Plan: Hermes Executor (Agentic LLM Backend)

**Branch**: `010-hermes-executor` *(branch/snapshot deferred)* | **Date**: 2026-06-03 | **Spec**: [spec.md](spec.md)
**Input**: Hermes as the agentic execution backend, Topology C (hybrid), always-agent for non-scripted turns, real write-actions v1, self-host `hermes-agent` (MIT).

## Summary

The engine becomes an **orchestrator + system-of-record + safety interlock** around a self-hosted **`hermes-agent`** (MIT) runtime. Non-scripted turns run as Hermes agent loops (plan→tool→observe); scripted funnel turns (003) stay deterministic. The engine injects context (persona + RAG 005 + few-shot 008 + history), exposes an **engine-mediated tool-gateway** (the agent calls back for every tool/action — gated by allowlist + permission + idempotency + audit), gates output through **validators (004)**, meters cost (007), and falls back to a thin completion on Hermes outage. Memory: engine Postgres = SoR; **Honcho** = working memory (reconstructible). Lifecycle: spawn-on-demand + hibernate + warm-pool; proactivity via the **009 scheduler** waking agents.

## Technical Context

**Language/Version**: TypeScript engine (Fastify) ↔ **self-host `hermes-agent`** (Python, MIT, v0.7.0) over HTTP
**Primary Dependencies**: `hermes-agent` (self-host; Docker baseline, Modal/Daytona for serverless-persistence/hibernate), **Honcho** (working memory), existing engine (Drizzle, Postgres+pgvector, Redis+BullMQ), **OmniRoute** (provider routing + metering), Langfuse (observability), OpenMeter (007 budgets)
**Storage**: engine Postgres (SoR + new: `agent_runs`, `action_audit`, persona tool-allowlist/agent flags); Honcho (working memory — external, reconstructible); Redis (warm-pool/lifecycle state, 009 cron)
**Testing**: Vitest (unit) + integration (mock `hermes-agent` HTTP + tool-gateway)
**Target Platform**: engine `packages/core` + a Hermes runtime sidecar in orchestra
**Constraints**: validators-gate over all output (004); engine-mediated tools only (no direct agent outbound/action); per-persona tool allowlist; write-action permission + idempotency + audit; per-tenant cost budget + hard loop/token cap; tenant isolation (Honcho namespace + Postgres RLS + tool tenant-scope); secrets server-side; fail-open to completion

## Constitution Check

- [x] Multi-tenant isolation (Postgres RLS + Honcho per-tenant namespace + tool-gateway tenant-scope)
- [x] Secrets server-side (engine owns LLM/CRM keys; agent never holds them — tool-gateway executes)
- [x] No naming-by-model (services named by purpose: `hermes-executor`, `tool-gateway`, `agent-lifecycle`)
- [x] Idempotency for write-actions (UNIQUE idempotency key + atomic) — no check-then-act
- [x] Engine = server-to-server; migrations as reviewed `.sql`
- [~] Principle VI (cross-AI review) — 2 external reviews received (claude + gemini, both MEDIUM); findings remediated → **re-review required for ≥2 PASS** before implement
- [ ] Principle VII (snapshot) — deferred

## Project Structure

```text
packages/core/src/services/hermes/
├── hermes-executor.ts      # runAgentTurn: invoke self-host hermes-agent + inject context + stream + hard maxExecutionMs timeout
├── hermes-adapter.ts       # isolates the hermes-agent v0.7.0 HTTP contract (pre-1.0 → adapter shields breaking changes; claude F3)
├── tool-gateway.ts         # engine-mediated tools/actions: allowlist + permission + idempotency + audit
├── agent-lifecycle.ts      # spawn-on-demand / hydrate(SoR+Honcho) / hibernate / warm-pool
├── turn-router.ts          # scripted(003) → deterministic ; else → Hermes (always-agent)
├── honcho-client.ts        # working-memory namespace (reconstructible from SoR)
└── guardrail.ts            # validators(004) outbound gate + budget/loop cap + fallback
packages/core/src/models/   # personas EXTEND (agentEnabled, toolAllowlist, agentConfig) + agent_runs + action_audit
packages/api/               # status-stream route (extends 002), wired in buildServer()
```

**Structure Decision**: all Hermes orchestration in `packages/core/src/services/hermes/`. The engine speaks HTTP to a self-hosted `hermes-agent` sidecar **via a thin `hermes-adapter`** that isolates the pre-1.0 (v0.7.0) HTTP contract (claude F3); **the agent reaches the world only through the engine tool-gateway** (its native terminal/browser are off unless allow-listed). Warm-pool ships a documented default size in Phase 2 (T009), tuned later in T023 (claude F6). 003 funnel engine untouched (router chooses it).

## Phase 0 — Research (resolved → research.md)

| Unknown | Resolution |
|---------|-----------|
| `hermes-agent` license (multi-tenant self-host resale) | **MIT — GREEN**, no restriction (vs n8n fair-code) |
| Integration shape | engine (TS) → self-host `hermes-agent` HTTP run-turn; **engine-mediated tool-gateway** (agent calls back; gated) |
| Dangerous native tools | terminal/browser **disabled** unless per-persona allow-listed |
| Memory | Honcho namespace per (tenant,persona,**conversation**); reconstructible from SoR; **fitness validated by gate T000c** (scale + failure + reconstruction round-trip; claude F1/F10) |
| Lifecycle | spawn-on-demand + hibernate; Docker baseline, Modal/Daytona = serverless-persistence; warm-pool; 009 cron heartbeat |
| Status stream | agent step-events (thinking/tool/answer) → engine SSE (extends 002) |
| Cost | hard per-turn loop/token cap + per-tenant budget (007); over-budget → curtail + fallback |

## Phase 1 — Design
- **data-model.md**: persona extension + `agent_runs` + `action_audit` (UNIQUE idempotency); Honcho external.
- **contracts/hermes-executor.contract.md**: runAgentTurn, tool-gateway, status-stream, outbound gate, proactive (009), fallback, lifecycle, security invariants.
- **quickstart.md**: self-host hermes-agent + Honcho + env.

## Risks & Complexity

| Risk | Sev | Mitigation |
|------|-----|------------|
| **Cost blowup (always-agent)** | **HIGH** | hard loop/token cap + per-tenant budget (FR-008) + warm-pool; over-budget curtail→fallback |
| **Write-action blast radius** (agent does wrong external write) | **HIGH** | engine-mediated tool-gateway only; permission allowlist; idempotency; audit; validators gate; confirm/dry-run high-stakes |
| **Agent off-script in funnel** | MED | router keeps scripted turns deterministic; stage-guard + validators override |
| **TS↔Python (hermes-agent) integration drift** (API v0.7.0) | MED | T000a gate pins the run-turn/tool-callback/stream contract; adapter isolates |
| **Two memory roles (Honcho vs SoR)** | MED | SoR authoritative; Honcho reconstructible; nothing-of-record only in Honcho |
| **Lifecycle at scale** (spawn/hibernate latency) | MED | warm-pool hot twins; serverless-persistence backend (Modal/Daytona) |
| **Abort/idempotency over multi-step side-effects** (002/009) | MED | reserve→execute→finalize idempotency; mid-loop abort + orphan-TTL sweep (FR-012; claude F2) |
| **Honcho unproven at multi-tenant scale** | MED | gate **T000c** validates scale + failure modes + SoR reconstruction; Honcho-down → cold-memory degrade (claude F1) |
| **Agent hang / unbounded loop latency** | MED | hard engine-side `maxExecutionMs` → force-abort → fallback (gemini F2); p95 budget (≤8 s warm/≤20 s cold) drives the value |
