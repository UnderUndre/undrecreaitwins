# Quickstart: Hermes Executor (010)

Self-host `hermes-agent` (MIT) as the engine's agentic backend.

## Prerequisites
- Engine up (Fastify, Postgres+pgvector, Redis, OmniRoute, Langfuse).
- **`hermes-agent`** self-hosted (Docker baseline; Modal/Daytona for serverless-persistence). + **Honcho** (working memory).
- 003 (funnels), 004 (validators), 005 (RAG), 008 (few-shot), 009 (scheduler) present.

## Env (server-side)
| Var | Purpose |
|-----|---------|
| `HERMES_BASE_URL` | self-host hermes-agent run-turn API (server-only) |
| `HONCHO_URL` | working-memory store |
| `AGENT_LOOP_CAP` / `AGENT_TOKEN_CAP` | per-turn hard caps (cost guard, FR-008) |
| `AGENT_WARM_POOL_SIZE` / `AGENT_IDLE_TTL_MS` | lifecycle |
| (existing) `LLM_PROVIDER_URL` | OmniRoute gateway + fallback completion |

## Run
```bash
# 1) bring up hermes-agent (Docker) + Honcho in orchestra
# 2) set persona.agentEnabled=true + toolAllowlist for a test assistant (via 008/010-admin)
cd packages/api && pnpm dev   # :8090
```

## Smoke
1. **Agentic reply**: chat a multi-step question → status stream (thinking/tool/answer) → validated answer.
2. **Scripted stays deterministic**: a turn inside an active 003 funnel does NOT go agentic.
3. **Write-action**: agent calls an allow-listed `*.write` → permission + idempotency + audit; a non-allow-listed tool → `denied`.
4. **Fallback**: stop hermes-agent → turn falls back to completion (degraded, not failed).
5. **Dožим**: 009 scan wakes a closer agent → anti-spam/validators gate → at most one send.
6. **Cost cap**: a runaway loop hits `loopCap` → `budget_exceeded` → curtail/fallback.
7. **Tenant isolation**: tenant B cannot see A's agent memory/runs/actions.

## Tests
```bash
pnpm test          # Vitest (executor, tool-gateway, router, guardrail — mock hermes-agent)
pnpm test:e2e      # agentic reply, write-action gating, fallback, dožim anti-spam, tenant isolation
```
