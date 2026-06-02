# Research: Hermes Executor (010)

## (a) `hermes-agent` license — ✅ RESOLVED (GREEN)
**Finding**: `NousResearch/hermes-agent` is **MIT** (v0.7.0 "Resilience", Feb 2026, 32k★). Self-hosted multi-tenant use AND SaaS resale are permitted with no fair-code/embed restriction — unlike n8n (Sustainable Use) or Activepieces (EE-for-embed). **No license blocker.** (Sources: github.com/NousResearch/hermes-agent/LICENSE.)
**Decision**: self-host (C3). Engine owns data/keys.

## (b) Integration shape — engine-mediated
**Decision**: engine (TS/Fastify) calls a **self-hosted `hermes-agent`** over HTTP to run a turn. The agent reaches the world ONLY through an **engine tool-gateway**: every tool/action the agent wants routes back to the engine, which enforces allow-list + permission + idempotency + audit + (for outbound) validators. `hermes-agent`'s native terminal/browser/sub-agents are **disabled unless allow-listed per persona**.
**Rationale**: keeps the guardrail authoritative; agent never holds tenant secrets or hits external systems directly.

## (c) Memory — Honcho working + engine SoR
**Decision**: Honcho namespace per `(tenantId, personaId[, externalUserId])`; holds working/user-model memory. Engine Postgres remains SoR (messages/persona/annotations/outcomes/RAG). Honcho MUST be reconstructible from SoR — nothing of record lives only in Honcho (portability). Letta dropped.
**Open**: confirm Honcho enforces per-tenant namespace isolation (T000b).

## (d) Lifecycle — spawn-on-demand + hibernate + warm-pool
**Decision**: agents spawn on a turn/heartbeat, hydrate from SoR+Honcho, hibernate/evict after idle TTL. **Backends**: Docker baseline; **Modal/Daytona** offer serverless persistence (good hibernate fit). Warm-pool keeps hot/premium twins warm. Proactivity is driven by the **engine 009 BullMQ scheduler** (heartbeat) — not Hermes' native always-on cron. Durable state never only in agent RAM.

## (e) Status streaming
**Decision**: the agent emits step-events (`thinking` / `tool_call` start+result / `answer` / `done` / `error`/`budget_exceeded`); the engine relays them over SSE (extends 002's stream). Sandbox/chat renders steps; channels get the final answer.

## (f) Cost control (always-agent ⇒ critical)
**Decision**: per-turn **hard loop cap** (max agent iterations) + token cap, and a **per-tenant budget** metered to OpenMeter (007). Over budget → curtail loop + fall back to a single completion; never unbounded spend. Provider routing via OmniRoute (also where metering hooks).

## (g) Routing
**Decision**: scripted (003 funnel active) → deterministic stage/slot path; **every other turn → Hermes (always-agent)**. Thin completion (`llm-client.ts`) survives only as the outage fallback.

## (h) Action / write model
**Decision**: write-actions (CRM/calendar/booking/external mutations) execute **only via the engine tool-gateway** under: per-persona permission allow-list, **idempotency key** (UNIQUE), audit log, validators gate; **high-stakes actions** require a confirm/dry-run step. v1 includes write-actions (C1).
