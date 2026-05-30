# Implementation Plan: 006 MTProto Channel

**Branch**: `specs/004-008` | **Date**: 2026-05-30 | **Spec**: [spec.md](file:///C:/Repositories/underundre/underhelpers/under-ai-helpers/undrecreaitwins/specs/006-mtproto-channel/spec.md)
**Input**: Feature specification from `/specs/006-mtproto-channel/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Adapter (`TwinChannel`) for connecting Telegram userbots to the Engine via MTProto, implementing the `IChannelAdapter` interface. It delegates authentication and session storage to the Product layer (`ai-twins/specs/mtproto-session`), focusing solely on runtime communication: message filtering, rate limits (FloodWait), and typing indicators.

## Technical Context

**Language/Version**: TypeScript (Node.js >= 20)  
**Primary Dependencies**: GramJS (or MTKruto), core Engine types (`IChannelAdapter`)  
**Storage**: N/A (Session string is provided dynamically via initialization)  
**Testing**: Vitest  
**Target Platform**: Node.js Server  
**Project Type**: library/module (`packages/channel-telegram-mtproto`)  
**Performance Goals**: Typing indicator response time < 500ms, strict backoff for rate limits  
**Constraints**: Avoid account bans via proactive rate limiting (queue up to 50 msgs, drop if FloodWait > 60s); ignore irrelevant chats/users  
**Scale/Scope**: ~1-3 core classes for MTProto bridging, <500 LOC.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I-III**: Does not edit generated files.
- **Principle VI (Cross-AI Review Gate)**: This plan and subsequent tasks will require `/speckit.review` passes from at least 2 external AI reviewers before execution.
- **Principle VII (Artifact Versioning)**: Snapshot tags will be enforced.
- **Constraints**: No sensitive data (API keys, session strings) will be hardcoded.

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
│   ├── adapter.ts       # TwinChannel implementing IChannelAdapter
│   ├── client.ts        # MTProto connection wrapper
│   ├── index.ts         # Public exports
│   └── types.ts         # Options and specific DTOs
├── test/
│   └── adapter.spec.ts  # Vitest cases
├── package.json
└── tsconfig.json
```

**Structure Decision**: Created a dedicated `packages/channel-telegram-mtproto` workspace in the monorepo to isolate MTProto dependencies (GramJS/MTKruto) from the core engine.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*No violations detected.*
