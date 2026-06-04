# Quickstart: Hermes Executor (010)

Self-host `hermes-agent` (MIT) as the engine's agentic backend.

## Prerequisites
- Engine up (Fastify, Postgres+pgvector, Redis, OmniRoute, Langfuse).
- **`hermes-agent`** self-hosted in **ACP mode** (`hermes acp`; engine spawns a managed pool — verify with `hermes acp --check`). + **Honcho** (working memory).
- 003 (funnels), 004 (validators), 005 (RAG), 008 (few-shot), 009 (scheduler) present.

## Env (server-side)
| Var | Purpose |
|-----|---------|
| `HERMES_ACP_CMD` | command the engine spawns for the ACP turn (e.g. `hermes acp --accept-hooks`); pooled |
| `ENGINE_MCP_SECRET` / `ENGINE_MCP_PORT` | engine-hosted HTTP MCP server (tool-gateway): auth secret + bind port |
| `HONCHO_URL` | working-memory store |
| `AGENT_LOOP_CAP` / `AGENT_TOKEN_CAP` / `AGENT_MAX_EXECUTION_MS` | per-turn hard caps + timeout (cost guard, FR-008 / gemini F2) |
| `AGENT_WARM_POOL_SIZE` / `AGENT_IDLE_TTL_MS` | lifecycle |
| (existing) `LLM_PROVIDER_URL` | OmniRoute gateway + fallback completion |

## Run
```bash
# 0) apply migrations from the REPO ROOT: pnpm db:migrate   (drizzle.config.ts lives at the root, not packages/core)
# 1) bring up hermes-agent (ACP-capable) + Honcho in orchestra; engine spawns `hermes acp` per pool slot
# 2) set persona.agentEnabled=true + toolAllowlist for a test assistant (via 008/010-admin)
cd packages/api && pnpm dev   # :8090
```

## Smoke
1. **Agentic reply (ACP)**: chat a multi-step question → ACP `session/update` stream (thinking/tool/answer) → validators gate → answer.
2. **Scripted stays deterministic**: a turn inside an active 003 funnel does NOT go agentic.
3. **Write-action (engine-MCP)**: agent calls an allow-listed `*.write` via the engine MCP server → permission + reserve→execute→finalize idempotency + audit; non-allow-listed → `denied`; high-stakes → dry-run/confirm.
4. **Fallback**: stop hermes-agent / hit `maxExecutionMs` → turn falls back to thin completion via `LLM_PROVIDER_URL` (degraded, not failed).
5. **Dožим**: 009 scan wakes a closer agent → anti-spam/validators gate → at most one send.
6. **Cost cap**: a runaway loop hits `loopCap` → `budget_exceeded` → curtail/fallback.
7. **Tenant isolation**: tenant B cannot see A's agent memory/runs/actions.

## Tests
```bash
pnpm test          # Vitest (executor, tool-gateway, router, guardrail — mock hermes-agent)
pnpm test:e2e      # agentic reply, write-action gating, fallback, dožim anti-spam, tenant isolation
```
