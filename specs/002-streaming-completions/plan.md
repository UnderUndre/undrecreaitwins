# Implementation Plan: Real Streaming Completions

**Branch**: `specs/002-streaming-completions` | **Date**: 2026-05-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/002-streaming-completions/spec.md`

## Summary

Replace the fake streaming implementation in `/v1/chat/completions` with real token-by-token SSE streaming. Add `ChatService.completeStream()` as an `AsyncGenerator<StreamChunk>`, a streaming `callLLMStream()` that consumes the LLM provider's `response.body` ReadableStream, rewrite `handleStream()` to pipe tokens as they arrive, and wire up AbortController + usage accounting + message persistence after stream completion. Non-streaming path unchanged.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥20
**Primary Dependencies**: Fastify (SSE via `reply.raw`), native `fetch` (ReadableStream), drizzle-orm
**Storage**: PostgreSQL (usage_events, messages, conversations — no schema changes)
**Testing**: vitest (unit + integration)
**Target Platform**: Linux server (Docker)
**Project Type**: Monorepo library packages (core, api, shared)
**Performance Goals**: First chunk within TTFT + 200ms, ≥10 chunks per 100 tokens
**Constraints**: No new dependencies, backward-compatible non-streaming path, bounded memory
**Scale/Scope**: Single feature, 4 files, ~200 LOC added

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth | PASS | No `.claude/` or generated file changes |
| II. Transformer, Not Fork | PASS | No new AI tool targets |
| III. Protected Slots | PASS | No managed file edits |
| IV. SemVer 0.x | N/A | No package.json version changes (feature in separate branch) |
| V. Token Economy | PASS | No new agents/skills/commands |
| VI. Cross-AI Review Gate | PENDING | Required before `/speckit.implement` |
| VII. Artifact Versioning | PENDING | Snapshot after plan + tasks stages |
| VIII. Self-Maintaining | PASS | Streaming pattern may become `/learn` candidate post-ship |

**Gate**: PASS — no blockers. Principles VI and VII are process gates, not design blockers.

## Project Structure

### Documentation (this feature)

```text
specs/002-streaming-completions/
├── spec.md
├── plan.md
├── quickstart.md
├── contracts/
│   └── streaming-sse.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/
├── shared/src/
│   └── types/
│       └── streaming.ts          # NEW — StreamChunk, StreamDelta types
│       └── index.ts              # MODIFY — re-export streaming types
├── core/src/
│   └── services/
│       └── chat-service.ts       # MODIFY — add completeStream(), callLLMStream()
└── api/src/
    └── routes/
        └── chat-completions.ts   # MODIFY — rewrite handleStream()
```

**Structure Decision**: Existing monorepo structure — no new packages. Types go to `shared/src/types/streaming.ts` following the existing type organization pattern.

## Design Decisions

### DD-001: AsyncGenerator vs ReadableStream

**Decision**: `completeStream()` returns `AsyncGenerator<StreamChunk>`.

**Rationale**: AsyncGenerators are native to TypeScript, composable with `for await...of`, and don't require importing Node.js `stream` module. The route layer formats to SSE — separation of concerns.

**Alternatives rejected**:
- `ReadableStream<StreamChunk>`: More complex to create from parser, no ergonomic benefit for single-consumer pattern.
- Event emitter: Legacy pattern, harder to type, no backpressure.

### DD-002: Token accumulation for persistence

**Decision**: Concatenate `delta.content` inside the generator as tokens arrive. After generator completes, persist all messages + usage in one transaction.

**Rationale**: Bounded memory (string concatenation only), single DB transaction, consistent with non-streaming path.

### DD-003: AbortController lifecycle

**Decision**: Create `AbortController` in route layer (`handleStream`). Pass `signal` to `completeStream()`. Listen to `request.raw.on('close')` to abort.

**Rationale**: Route owns the HTTP lifecycle. Service layer stays transport-agnostic. On abort, generator stops yielding, route skips persistence.

### DD-004: LLM SSE parsing

**Decision**: Parse LLM provider's SSE response manually using `TextDecoderStream` + line-by-line parsing. No external SSE parser dependency.

**Rationale**: OpenAI SSE format is trivial (`data: {...}\n\n`). Adding a dependency for this is over-engineering. Manual parsing gives full control over error handling.

## Data Flow

```
Client POST /v1/chat/completions {stream: true}
  │
  ▼
handleStream() [chat-completions.ts]
  ├── AbortController + request.raw.on('close')
  ├── Create conversation (findOrCreateConversation)
  ├── Fetch Letta memory
  │
  ▼
chatService.completeStream() [chat-service.ts]
  │
  ▼
callLLMStream() [chat-service.ts]
  ├── fetch(providerUrl, {stream: true, signal})
  ├── response.body (ReadableStream)
  ├── TextDecoderStream → line parser
  ├── yield StreamChunk per token
  └── yield final StreamChunk with usage
  │
  ▼
handleStream() receives StreamChunks:
  ├── Format to SSE: `data: ${JSON.stringify(chunk)}\n\n`
  ├── Write to reply.raw
  ├── Accumulate content for persistence
  └── On done:
      ├── persistMessages()
      ├── emitUsageEvent()
      └── reply.raw.end()
```
