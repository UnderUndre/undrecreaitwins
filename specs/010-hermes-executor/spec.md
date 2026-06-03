# Feature Specification: Hermes Executor (Agentic LLM Backend)

**Feature Branch**: `010-hermes-executor` *(branch/snapshot deferred — no commit without consent)*
**Created**: 2026-06-03
**Status**: Clarified (review-remediated 2026-06-03)
**Input**: Make the twin a **powerful agent-assistant** (tools, multi-step reasoning, proactive follow-ups), not a single-completion chatbot. Integrate **Hermes** (Nous `hermes-agent`) as the agentic execution backend, **hybrid-routed** (Topology C); the engine stays orchestrator + system-of-record + guardrail.

## Overview

Today the engine answers each turn with ONE OpenAI-compatible completion (`packages/core/src/services/llm-client.ts`) — no tools, no multi-step, no autonomy. This feature adds **Hermes as an agentic executor** for the turns that need it, keeping the engine's determinism where it matters (scripted funnels, compliance).

**Decisions locked (brainstorm 2026-06-03):**
- **Topology C — hybrid routing**: engine routes each turn — scripted/fast → deterministic path; open/tool-needing → Hermes agent; proactive dožimy → Hermes via the engine scheduler.
- **Memory**: engine Postgres = durable **system-of-record**; **Honcho** (Hermes-native) = working/user-model memory, **reconstructible from the SoR** (no lock-in). **Letta dropped.**
- **Lifecycle**: **spawn-on-demand + hibernate + warm-pool**; proactivity driven by the **engine BullMQ scheduler (009)** waking agents — not Hermes always-on cron.
- **Routing (C2)**: **always-agent** for non-scripted turns — every open turn runs through Hermes; thin completion survives only as the outage **fallback** (FR-009). No cost fast-path.
- **Actions (C1)**: **real write-actions in v1** (CRM/calendar/booking/external mutations) — under per-tenant permission + audit + idempotency + validator gate.
- **Deployment (C3)**: **self-host `hermes-agent`** (OSS) in orchestra — full multi-tenant control; engine owns data/keys.

> **Boundary (DD-HX-001)**: **Engine owns** routing, the durable SoR (Postgres: messages/persona/annotations/outcomes/RAG), all **guardrails** (validators 004 = outbound gate; anti-spam 009; per-persona tool sandbox; cost metering), channel I/O, and agent lifecycle. **Hermes owns** the agentic loop (plan→tool→observe→repeat) + working memory (Honcho). **Hermes never sends outbound or executes an action without passing the engine guardrail gate.** Hermes = brain; engine = nervous system + safety interlock.

## User Scenarios

### US1 — Agentic reply (P1) 🎯 MVP
Open/complex/tool-needing turn → engine injects persona + RAG (005) + annotation few-shot (008) + conversation context → Hermes runs an agent turn → validators (004) gate output → reply persisted + delivered.
**Acceptance**: a multi-step/tool question yields a correct multi-step answer; validators block non-compliant output; on Hermes outage the turn falls back to the thin completion path (degraded, not failed).

### US2 — Hybrid routing (P1)
Engine routes each turn: **scripted** (003 funnel active) → deterministic stage/slot path (Hermes may fill slot text under stage control); **everything else → Hermes agent** (always-agent, C2). Funnel determinism preserved — the agent cannot skip/break stages. Thin completion is fallback-only (FR-009), not a routine lane.
**Acceptance**: a turn inside an active funnel stage stays on-script (stage advances only on slot-fill); a non-scripted turn uses Hermes; the routing decision is logged.

### US3 — Agentic dožimy / proactive close (P2)
009 scan marks a dormant conversation eligible → **wakes** a Hermes "closer" agent (spawn) → agent crafts a context-aware multi-step follow-up (may read CRM/calendar) → **009 anti-spam + 004 validators gate** → send or suppress → hibernate.
**Acceptance**: no double-send / no spam under autonomy (009 idempotency + minInterval hold); a suppressed nudge is logged; the agent never sends directly.

### US4 — Tool / action execution incl. write-actions (P1, C1)
The assistant executes **allow-listed** tools/actions — **including real write-actions** (CRM-write, booking, external mutations) — under a **per-persona sandbox** + permission + audit + idempotency.
**Acceptance**: a sales twin has NO terminal / arbitrary-browser; only allow-listed tools run; write-actions require explicit per-persona permission, are idempotent, audited, and tenant-scoped; high-stakes actions follow a confirm/dry-run policy (C1).

### Edge Cases
- Hermes down/slow → fallback to thin completion (fail-open); status surfaced.
- Agent goes off-script in a funnel → validator/stage-guard overrides; stage not advanced.
- Agent loop exceeds budget (depth/tokens/$) → typed `agent_budget_exceeded`; best-effort partial or fallback.
- Tool/action fails mid-loop → graceful; no partial side-effects committed without idempotency.
- Honcho/working memory lost → rebuilt from engine SoR (no loss of record).
- Abort mid-loop (002) → in-flight side-effects cleaned/idempotent; no orphan actions.
- Cron wakes agent but anti-spam blocks → agent work discarded, nothing sent.
- Cross-tenant → Honcho namespace + tool sandbox + RLS prevent any leak.
- **Concurrent turns, same persona** (claude F7) → per-`(tenant,persona,conversation)` session + Honcho sub-namespace; no working-memory collision.
- **Hermes crash mid-loop with tool-callback in-flight** (claude F2) → orphaned `pending` swept `abandoned` after `TOOL_CALLBACK_TTL` + reconciled.
- **Honcho down/slow** (claude F1) → cold-memory degrade; turn proceeds.
- **High-stakes write-action** (claude F4/gemini F1) → dry-run + `action_pending_approval` pause → approve → resume.
- **Per-tenant budget exhausted** (claude F13) → in-flight completes, new agentic turns refused.
- **Engine-side timeout `maxExecutionMs`** (gemini F2) → force-abort → fallback.

## Functional Requirements

- **FR-001**: Engine MUST route each turn: **scripted** (003 funnel active) → deterministic stage/slot path; **all other turns → Hermes agent (always-agent, C2)**. The thin completion path is NOT a routine lane — it exists only as the Hermes-outage fallback (FR-009). **Scripted clarification (I1/gemini F4)**: scripted turns are engine-controlled (deterministic stage/slot); within a stage the response TEXT MAY be Hermes-generated under stage constraint, but the agent NEVER drives stage transitions (constrained generator inside the 003 state machine, not a free loop). **Cost decision (gemini F3 / claude alt-1 — RESOLVED 2026-06-03)**: trivial-ack fast-path **rejected** by user; **C2 stands** — every non-scripted turn is agentic, no intent pre-filter. Cost is bounded solely by per-turn `loopCap`/`tokenCap` (FR-008) + per-tenant budget. Trade-off (5–50× on content-free acks) accepted in favor of a uniformly powerful agent.
- **FR-002**: For agentic turns the engine MUST invoke a Hermes agent turn, injecting persona prompt + RAG (005) + annotation few-shot (008) + conversation context; Hermes runs the loop.
- **FR-003**: **Validators (004) are the mandatory outbound gate** over every Hermes output before persist/send (non-deterministic agent ⇒ hard gate).
- **FR-004**: **Memory** — engine Postgres is the durable SoR; Honcho holds working/user-model memory and MUST be reconstructible from the SoR; nothing of record lives only in Honcho. Letta is not used. **Reconstruction (claude F10)**: seed from SoR (last-N messages + annotations) on spawn when empty/stale; auto on Honcho health-miss or via admin. **Honcho down/slow → degrade to cold memory** (turn proceeds, no enrichment), never hard-fail (claude F1). *(Honcho fitness validated by gate T000c.)*
- **FR-005**: **Lifecycle** — agents spawn-on-demand, hydrate from SoR+Honcho, hibernate/evict after idle TTL; a warm-pool keeps hot/premium twins warm. No always-on-per-persona at scale.
- **FR-006**: **Proactivity** — the engine BullMQ scheduler (009) is the heartbeat that wakes agents for dožimy windows; Hermes' native always-on cron is NOT the driver. All proactive outbound passes 009 anti-spam + 004 validators.
- **FR-007**: **Tool sandbox + action permission** — each persona has an allow-list of tools/actions; terminal/arbitrary-browser off by default; **write-actions require explicit per-persona permission**, server-side enforcement, tenant-scoped. **High-stakes** = allow-list entry with `requiresConfirmation` (operator-config, A1); these follow a **confirm/dry-run** protocol: dry-run → `action_pending_approval` event → pause turn → approver accept/reject → resume (contract §High-stakes; claude F4 / gemini F1).
- **FR-008**: **Metering** — every agent turn's LLM + tool calls MUST emit usage to OpenMeter (007) with per-tenant budgets; loop depth/token caps enforced. **Budget boundary (claude F13)**: per-tenant budget exhausted → finish in-flight turn, **refuse new** agentic turns; per-turn cap hit → **curtail loop + finalize** best answer (not a hard mid-loop kill).
- **FR-009**: **Fallback** — a **hard engine-side timeout `maxExecutionMs`** (gemini F2) OR Hermes unavailable / `budget_exceeded` → force-abort + degrade to the thin OpenAI-compatible completion path (fail-open), surfaced as degraded.
- **FR-010**: **Status streaming** — agentic turns expose a status stream (thinking / tool-call / answer), extending 002 (not just token stream); sandbox/chat renders steps.
- **FR-011**: **Audit** — every tool/action execution is logged (tenant, persona, action, redacted args, outcome).
- **FR-012**: **Abort/idempotency for write-actions** — **reserve→execute→finalize** with `UNIQUE(idempotencyKey)`: reserve `pending` BEFORE the side-effect; conflict ⇒ replay prior result, never re-execute (U1). Mid-loop abort / Hermes-crash-mid-callback → orphaned `pending` swept `abandoned` after `TOOL_CALLBACK_TTL` + reconciled; no double-write, no silent orphan (claude F2).

## Non-Functional

- **Cost (CRITICAL — always-agent, C2)**: every non-scripted turn is a full agent loop (5–50× the calls of a completion) → per-tenant budget + hard per-turn loop/token cap are **mandatory v1**; metering authoritative (007); over-budget → degrade/curtail, not unbounded spend.
- **Isolation**: Honcho per-tenant namespaces + tool sandbox + Postgres RLS — zero cross-tenant memory/tool/data.
- **Security**: no terminal/arbitrary browser by default; write-actions permissioned + audited (C1).
- **Reliability**: fail-open to completion; durable state never only in agent RAM.
- **Observability**: Langfuse nested spans for agent loops; reconcile with Hermes' own tracing.
- **Latency (always-agent)**: every open turn is a multi-step loop → warm-pool is **load-bearing**; status-streaming (FR-010) is the UX cover. **Initial p95 budget (claude F9)**: agentic turn ≤ ~8 s warm / ≤ ~20 s cold-spawn (tunable; drives warm-pool sizing + `maxExecutionMs`).

## Success Criteria

- **SC-001**: an agentic turn needing a tool/multi-step produces a correct answer the thin-completion path could not.
- **SC-002**: 0 double-send / 0 spam under autonomous dožimy (009 guards hold).
- **SC-003**: 0 cross-tenant memory/tool/data leakage in security testing.
- **SC-004**: Hermes-down → 100% of turns fall back to completion (no hard failures).
- **SC-005**: per-turn cost bounded (loop cap honored, budget enforced); metered to OpenMeter.

## Glossary

- **Agentic turn** — reply produced by a Hermes agent loop (vs a single completion).
- **Scripted turn** — a funnel (003) turn driven by the engine state machine.
- **Dožim** — proactive closing/win-back push (009), here possibly agent-crafted.
- **Working memory** = Honcho (Hermes), derived/reconstructible. **SoR** = engine Postgres, authoritative.
- **Guardrail gate** = validators (004) + anti-spam (009) + tool-sandbox + metering, between Hermes and any outbound/action.

## Out of Scope

- Replacing the deterministic funnel engine (003) — it stays; Hermes augments.
- Hermes hosting/ops details — C3 + separate ops concern.
- Building agent memory from scratch — adopt Honcho.
- **Broad concrete external tool integrations** (full CRM/calendar matrix) — future spec; v1 ships the tool-gateway + a **starter set** (`rag.search` + read exemplars + one write exemplar via adapter stubs) (claude F11).
- The Product agent-builder UI — `ai-twins/010-agent-builder-admin` (consumer).

## Dependencies

- **002** (streaming → status-stream), **003** (funnel routing), **004** (validators gate — becomes critical), **005** (RAG context), **008** (few-shot + outcome loop), **009** (scheduler heartbeat + anti-spam gate), **007/OmniRoute** (gateway + metering).
- **Hermes** (Nous `hermes-agent`, **self-host**, C3) + **Honcho**. ⚠️ **License flag (reduced by self-host)**: confirm the OSS `hermes-agent` license permits your self-hosted multi-tenant use; the managed-resale-embed concern is moot since self-hosting. *Verify license; not confirmed.*

## Clarifications

### Session 2026-06-03
- **C1 (action scope)** → **real write-actions in v1** (CRM/calendar/booking/external mutations) under per-persona permission + audit + idempotency + validator gate (FR-007/011/012); high-stakes → confirm/dry-run. *(Max power, larger risk/audit surface — accepted.)*
- **C2 (routing)** → **always-agent**: scripted → deterministic (003); every other turn → Hermes. Thin completion = fallback-only (FR-009). *(Cost/latency now CRITICAL NFRs — loop-cap + budget + warm-pool mandatory v1.)*
- **C3 (deployment)** → **self-host `hermes-agent`** (OSS) in orchestra; engine owns data/keys. *(Resale-embed license concern moot; verify OSS license + own the ops.)*
