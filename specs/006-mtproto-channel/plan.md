# Implementation Plan: 006 MTProto Channel

**Branch**: `specs/004-008` | **Date**: 2026-05-30 | **Spec**: [spec.md](file:///C:/Repositories/underundre/underhelpers/under-ai-helpers/undrecreaitwins/specs/006-mtproto-channel/spec.md)
**Input**: Feature specification from `/specs/006-mtproto-channel/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Standalone adapter (`TelegramMtprotoAdapter`) connecting Telegram userbots to the Engine via MTProto, implementing the **canonical `ChannelAdapter`** from `@undrecreaitwins/shared` and bridging to the Engine over the shared Redis Streams `ChannelTransport` — same process model as `channel-telegram` (Bot API) / `channel-whatsapp` (codex F1/F5). Authentication + session storage delegated to Product (`ai-twins/specs/mtproto-session`); secrets resolved by handle, never raw/logged (codex F4). Runtime concerns: inbound eligibility + loop-prevention (codex F6), idempotency/resync (codex F2), RPC error policy — FloodWait/DC-migration (codex F3), typing.

## Technical Context

**Language/Version**: TypeScript (Node.js >= 20)  
**Primary Dependencies**: GramJS (`telegram`); `@undrecreaitwins/shared` (canonical `ChannelAdapter`/`ChannelMessage`/`ChannelHealth`); `@undrecreaitwins/core` (`ChannelTransport` — Redis Streams)  
**Storage**: Redis — idempotency dedup keys `mtproto:dedup:{channelId}` (codex F2). Session string owned by Product (encrypted at rest), resolved by handle — never persisted here (codex F4)  
**Testing**: Vitest  
**Target Platform**: Node.js Server  
**Project Type**: library/module (`packages/channel-telegram-mtproto`)  
**Performance Goals**: Typing indicator response time < 500ms, strict backoff for rate limits  
**Constraints**: standalone worker via `ChannelTransport` (no in-process engine coupling); secrets via `SecretResolver` only (redacted logs, at-rest by Product); per-peer FloodWait queue + RPC error policy (retry-after, DC-migration, account circuit-breaker); idempotent inbound (dedup) + reconnect catch-up; inbound eligibility (ignore self/outgoing, edits, media-only, service, channel posts) to prevent reply loops  
**Scale/Scope**: ~1-3 core classes for MTProto bridging, <500 LOC.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I-III**: Does not edit generated files.
- **Principle VI (Cross-AI Review Gate)**: This plan and subsequent tasks will require `/speckit.review` passes from at least 2 external AI reviewers before execution.
- **Principle VII (Artifact Versioning)**: Snapshot tags will be enforced.
- **Constraints**: `apiHash`/`sessionString` are bearer credentials — passed only via `SecretResolver` (handle), encrypted at rest by Product, redacted from all logs/errors/metrics; never hardcoded or serialized (codex F4).

## Project Structure

### Documentation (this feature)

```text
specs/006-mtproto-channel/
├── plan.md              
├── research.md          
├── data-model.md        
├── quickstart.md        
├── contracts/           
└── tasks.md             
```

### Source Code (repository root)

```text
packages/channel-telegram-mtproto/
├── src/
│   ├── adapter.ts       # TelegramMtprotoAdapter implements shared ChannelAdapter (+ ChannelTransport)
│   ├── client.ts        # MTProto connection wrapper (DC-migration, reconnect catch-up)
│   ├── eligibility.ts   # inbound filter + peer-id normalization (loop prevention)
│   ├── rate-limit.ts    # per-peer FloodWait queue + RPC error policy
│   ├── idempotency.ts   # Redis dedup {channelId, externalMessageId}
│   ├── secrets.ts       # SecretResolver usage + redaction + InvalidSessionError
│   ├── index.ts         # Public exports (TelegramMtprotoAdapter)
│   └── types.ts         # MtprotoAdapterOptions / DTOs (NO local adapter interface)
├── test/
│   ├── contract.spec.ts   # implements shared ChannelAdapter + mapping + eligibility
│   ├── protocol.spec.ts   # FloodWait / migration / non-retryable
│   ├── recovery.spec.ts   # reconnect / idempotency / no double-reply
│   └── secrets.spec.ts    # redaction + InvalidSessionError + timer cleanup
├── package.json
└── tsconfig.json
```

**Structure Decision**: Created a dedicated `packages/channel-telegram-mtproto` workspace to isolate MTProto deps (GramJS) from the core engine. It is a **standalone `ChannelAdapter` worker** (codex F5) — implements the shared contract and talks to the Engine only via `ChannelTransport` (Redis Streams), exactly like `channel-telegram` and `channel-whatsapp`. It does NOT run inside the Engine process.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*No violations detected.*
