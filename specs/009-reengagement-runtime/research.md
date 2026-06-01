# Research: Re-engagement Runtime (009)

## (a) Scan Scheduling Mechanism
**Decision**: Reuse BullMQ for scheduling.
**Rationale**: The engine already uses BullMQ (`packages/core/src/services/document-worker.ts`). We can create a repeatable job (`ReengagementScanJob`) that triggers the scanner every N minutes.
**Alternatives**: Node-cron (simpler but less resilient, no persistence), external trigger via API (adds dependency on external scheduler).

## (b) ChatService Hook Generation
**Decision**: Create a dedicated `ReengagementService` that leverages `ChatService` components (System Prompt builder, LLM Client) but operates on existing conversations.
**Rationale**: `ChatService.complete` currently creates a new conversation every time. Re-engagement must append to existing history.
**Call Shape**: 
```typescript
const hook = await llm.complete({
  messages: [
    { role: 'system', content: rule.template },
    ...history.map(m => ({ role: m.role, content: m.content }))
  ]
});
```

## (c) Unified Delivery Abstraction
**Decision**: Publish to `REDIS_STREAMS.OUTBOUND`.
**Rationale**: Adapters (`TelegramAdapter`, etc.) already consume from this stream. This ensures the hook is delivered through whichever channel is active for the conversation.
**Payload**:
```json
{
  "channel_id": "...",
  "message_id": "hook_uuid",
  "content": "Generated hook text",
  "tenant_id": "...",
  "external_user_id": "..."
}
```

## (d) FollowupAttempt State Machine
**Transitions**:
1. `scheduled`: Created by the scanner.
2. `processing`: Locked by a worker for hook generation.
3. `sent`: Successfully delivered to the outbound stream.
4. `failed`: Generation or delivery error (with `failureReason`).
5. `opted_out`: Conversation marked as `opted_out=true` during scan.
6. `expired`: Rule changed or conversation became active before the attempt was processed.

## (e) Idempotency Strategy (FR-009) — ⚠️ SUPERSEDED (see data-model.md + attempt-state-machine.contract.md)

> **Final design**: `UNIQUE(idempotencyKey)` where `idempotencyKey = convId:ruleId:cycleIndex` (`cycleIndex = reengagementCount`), inserted via `ON CONFLICT DO NOTHING`. Recovery = atomic claim + stuck-`processing` timeout sweep (FR-011). The text below is the original phase-0 alternative, kept for history.

**Decision**: Use a combination of `FollowupAttempt` unique index and atomic "claim" via DB transaction.
**Mechanism**: 
- Unique constraint on `(conversation_id, rule_id, scheduled_at)`.
- Worker claims a `scheduled` attempt by updating its status to `processing` where `status = 'scheduled'`.

## (f) Anti-Spam (FR-006)
**Rules**:
1. `maxAttempts`: Stop if `FollowupAttempt` count for (conversation, rule) >= `rule.maxAttempts`.
2. `backoff`: Next attempt `scheduled_at` = `lastReengagementAt + backoff_interval[reengagementCount]`.
3. `minInterval`: Ensure at least N hours between any two hooks for the same conversation across all rules.

## (g) Batching for SC-004
**Decision**: Use Drizzle `offset`/`limit` or `where` with primary key cursor for batching.
**Query**:
```typescript
const batch = await db.select()
  .from(conversations)
  .where(and(
    eq(conversations.needsReengagement, true),
    lte(conversations.lastMessageAt, staleThreshold)
  ))
  .limit(1000);
```

## (h) DD-RE-001 Migration Ownership
**Decision**: Product repo (`ai-twins`) will author the migration for `followup_rules` and `followup_attempts`.
**Rationale**: Following DD-RE-001, since Product authors the configuration UI for rules and needs to read attempts for reporting, it's cleaner if the shared schema is defined there. The Engine will import or mirror the schema in Drizzle.
**Gate**: Coordination with `006-reengagement-admin` is mandatory before either side runs `migrate`.

## (i) Runtime Conversation Fields — ⚠️ SUPERSEDED (see data-model.md)

> **Final design**: boolean `needsReengagement` + `lastReengagementAt` + `reengagementCount` + `optedOut` (NOT a `reengagement_status` enum). The text below is the original phase-0 alternative, kept for history.

**Fields**:
- `reengagement_status`: `idle` | `scheduled` | `completed` | `opted_out`.
- `last_reengagement_at`: Timestamp of last sent hook.
- `reengagement_count`: Number of hooks sent for the current staleness cycle.
