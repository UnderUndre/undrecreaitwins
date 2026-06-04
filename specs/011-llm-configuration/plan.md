# Implementation Plan: Per-Assistant LLM Provider Configuration (Runtime)

**Branch**: `011-llm-configuration` *(planning artifacts only; branch/snapshot deferred — no commit without consent)* | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/011-llm-configuration/spec.md`

## Summary

Make the LLM provider **per-assistant** (with a tenant-level default) in the engine: store a BYOK custom OpenAI-compatible config (base URL + encrypted key + model id + `temperature`/`max_tokens`) in the SoR, resolve `assistant → tenant → platform default`, **inject** the effective config into the assistant's Hermes turn (010 ACP), and **durably retry on the same provider** when it fails (009 BullMQ), refining 010 FR-009 (no silent thin-completion model-swap). SSRF-guard the user-supplied base URL; meter BYOK turns to OpenMeter with a flag.

Approach: extend persona (008) with a `1:0..1` provider-config entity + a tenant-default entity (Drizzle/Postgres, key encrypted at rest via 007 KMS envelope); add a provider-config service + internal API for the Product BFF; wire effective-config injection into the existing `packages/core/src/services/hermes/*` executor; add a BullMQ provider-failure retry worker; enforce SSRF egress at the engine. **Gate T000-LLM**: empirically verify whether Hermes ACP `session/new` accepts a per-session model/provider override (drives injection strategy A vs fallback B).

## Technical Context

**Language/Version**: TypeScript / Node (engine `packages/core`)
**Primary Dependencies**: Drizzle ORM + Postgres (SoR); BullMQ (durable-retry, 009); Hermes `hermes-agent` via ACP (010, `hermes-adapter.ts`/`hermes-executor.ts`/`mcp-server.ts`); OpenMeter (metering, 007); validators (004, unchanged gate); Honcho (memory, untouched)
**Storage**: Postgres (Drizzle) — 2 new entities (`LLMProviderConfig`, `TenantLLMDefault`); API key **encrypted at rest** (007 KMS envelope) — *substrate confirmed in research.md*
**Testing**: vitest (unit/integration) + integration harness for ACP/MCP (cf. 010 T000a)
**Target Platform**: self-host orchestra (C3, 010); engine owns data/keys
**Project Type**: web-service (engine runtime backend)
**Performance Goals**: preserve 010 warm-pool budget — agentic turn p95 ≤ ~8 s warm / ≤ ~20 s cold; injection must not collapse warm reuse for common configs
**Constraints**: zero message loss on provider outage (durable-retry); API key never logged/traced/cross-tenant; SSRF egress blocked; pooling coherence (no stale/foreign config in a pooled process — T000d hazard class)
**Scale/Scope**: multi-tenant; few distinct provider configs per deployment (bounds pool-by-config fallback)

## Constitution Check

*GATE: must pass before Phase 0. Re-checked after Phase 1.*

| Principle | Applies? | Status |
|---|---|---|
| I–III (source-of-truth, transformer-not-fork, protected slots) | clai-helpers-repo-internal | N/A to this engine feature |
| IV (SemVer) | clai-helpers CLI only | N/A |
| V (token economy of `.claude/` artifacts) | soft/generic | Honored — terse artifacts |
| **VI (Cross-AI Review Gate, NON-NEGOTIABLE)** | **Yes** | Pending — `/speckit.analyze` + ≥2 external reviews required before `/speckit.implement` |
| **VII (Artifact Versioning)** | **Yes** | Snapshots **deferred** per session norm (no commit without consent); tag on commit |
| VIII (self-maintaining knowledge) | soft signal | N/A now |
| **IX (Two-Phase Branch Flow)** | **Yes** | `specs/011-llm-configuration` planning branch **deferred**; impl branch later |
| Plumber's Loop + WRAP (<500 LOC/task, refactor XOR feature) | Yes | Tasks sized accordingly |

**Verdict**: PASS — no violations. Git-bound principles (VI/VII/IX) deferred by explicit session norm, to be honored at commit/implement time. No Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/011-llm-configuration/
├── plan.md              # This file
├── research.md          # Phase 0 — gates (T000-LLM, encryption, pooling, SSRF, retry)
├── data-model.md        # Phase 1 — LLMProviderConfig, TenantLLMDefault, resolution
├── quickstart.md        # Phase 1 — verification flow
├── contracts/
│   └── llm-provider.contract.md   # internal API (BFF-facing) + injection + retry contract
└── tasks.md             # Phase 2 (/speckit.tasks)
```

### Source Code (engine `packages/core`)

```text
packages/core/src/
├── db/
│   └── schema/
│       └── llm-provider.ts          # NEW — Drizzle: llm_provider_config, tenant_llm_default (path per existing convention — confirm)
├── services/
│   ├── llm-provider/                # NEW — config CRUD + resolution + crypto + SSRF guard + test-connection
│   │   ├── provider-config.service.ts
│   │   ├── resolution.ts            # assistant → tenant → platform default
│   │   ├── crypto.ts                # KMS-envelope encrypt/decrypt (decrypt only at injection)
│   │   ├── ssrf-guard.ts            # base_url egress allow/deny
│   │   └── test-connection.ts
│   ├── hermes/                      # EXTEND (010)
│   │   ├── hermes-executor.ts       # inject effective config into ACP turn (strategy A/B)
│   │   ├── hermes-adapter.ts        # provider/model/base_url/key/params plumbing
│   │   └── mcp-server.ts            # (unchanged gate; tool mediation)
│   ├── llm-client.ts                # EXTEND — thin-completion path also honors effective config (FR-009)
│   └── retry/
│       └── provider-retry.worker.ts # NEW — BullMQ durable-retry on provider failure (009)
└── api/                             # NEW internal endpoints (BFF-facing) — provider-config CRUD + test-connection
```

**Structure Decision**: extend the existing engine `packages/core` service layer. New `services/llm-provider/` owns config+crypto+resolution+SSRF+test-connection; the `hermes/` executor and `llm-client.ts` are **extended** (not replaced) to consume the effective config; durable-retry rides a new BullMQ worker on the 009 queue. DB schema follows the existing Drizzle convention (exact file path confirmed against current schema layout in data-model.md).

## Complexity Tracking

No constitution violations — table omitted. The one notable risk (injection vs warm-pool) is handled by **gate T000-LLM** + the A→B strategy fallback, not by added structural complexity.
