# Research: Script Funnels — Dialog Funnel Runtime

## 1. Russian Stemmer Investigation

The requirement for a deterministic fragment scorer with a Russian stemmer can be met using the `natural` library or `snowball-stemmer.jsx`.

- **Decision**: Use `natural` (specifically `natural.PorterStemmerRu`) because it is well-tested, supports multiple languages (for future FR-003), and includes utilities for tokenization and string distance which will be useful for scoring.
- **Performance**: Stemming a typical message (<500 characters) takes ~1-5ms on Node.js, well within the 100ms budget.
- **ESM Compatibility**: `natural@6.x` supports ESM imports via named exports. If CJS-only exports are encountered in a specific version, use dynamic `import()` with CJS interop as a fallback. Verify ESM support during T001 dependency installation.
- **Stemmer Quality**: PorterStemmerRu is a light stemmer — it may over-stem or under-stem for conversational Russian (slang, diminutives, colloquialisms, mixed Russian-English). **Mitigation**: T010 includes a stemmer quality validation test with curated Russian phrases. If quality is insufficient for specific word forms, maintain a custom exception dictionary alongside the stemmer.

## 2. Ingestion Pattern (FR-014)

The existing persona ingestion pattern in `packages/api/src/routes/personas.ts` uses:
1. Fastify routes with Zod validation.
2. `PersonaRepository` in `packages/core` for Drizzle-based CRUD.
3. Optimistic locking via `version` column.
4. Authentication via `authPlugin` (Bearer JWT) + `tenantPlugin` (`X-Tenant-ID` validated against JWT claims).

- **Decision**: Mirror this exactly for funnels.
  - `POST /v1/funnels` — ingest (creates a new version)
  - `GET /v1/funnels` — list definitions for tenant
  - `GET /v1/funnels/:id` — get definition with active version
  - `PATCH /v1/funnels/:id` (with If-Match support) — update metadata
  - `DELETE /v1/funnels/:id` — soft-delete (see §12)

## 3. Storage and Concurrency (FR-012, FR-015)

- **Funnels/Fragments/Stages**: Store in PostgreSQL using Drizzle. Funnel versions are immutable snapshots — never mutated after creation (see §7).
- **Conversation State**: Store in PostgreSQL (`conversation_funnel_states` table).
- **Concurrency**: Use a `version` column on the conversation funnel state table. Use `UPDATE ... WHERE version = :expected` for slot updates and stage transitions.

### CAS Retry Policy

Both stage transitions and slot updates share the `version` column for compare-and-set:

- **Max retries**: 3 (immediate retry, no backoff — PG round-trip is fast enough)
- **On exhaustion (slot updates)**: log warning via `logger.warn({ conversationId, slotName, err })`, skip the update. The slot remains unfilled/stale and will be retried on the next turn's async slot verification cycle.
- **On exhaustion (stage transitions)**: fail the turn with a retriable error. Stage state is critical to fragment selection correctness.
- **Contention note**: Stage transitions and slot updates CAN collide on the same `version` counter since they update the same row. Under normal operation (one turn at a time per conversation, slots processed async after the turn), contention is rare. Under concurrent turns (see §11), the per-conversation Redis lock serializes access, eliminating CAS contention.

## 4. Async Slot Verification (FR-011)

Slot verification requires an LLM call but must not block the response.

- **Strategy**:
  1. `ChatService` emits a `message.processed` event.
  2. A `SlotVerificationService` listens to this event.
  3. It identifies missing slots for the current funnel/stage.
  4. It calls the LLM with the context to extract/verify slots.
  5. It updates the conversation state if a slot is confirmed (via CAS — see §3).

### Transport Decision

Implement behind a `SlotVerificationTransport` interface with two implementations:

| Transport | When | Pros | Cons |
|-----------|------|------|------|
| **EventEmitter** (in-process) | Development, single-instance | Simple, no infra dependency | Lost on process restart, no cross-instance |
| **Redis queue** (via ioredis) | Production, multi-instance | Survives restarts, cross-instance | Operational complexity |

Config: `SLOT_VERIFICATION_TRANSPORT=emitter|redis` (default: `emitter`).

### Timeout, Retry, and Circuit Breaker

- **Per-attempt timeout**: 15 seconds (LLM call + context assembly)
- **Max retries**: 2 (total 3 attempts per slot per turn)
- **Backoff**: exponential (1s, 2s)
- **Circuit breaker**: If 5 consecutive verification attempts fail across any slots, disable slot verification for 60 seconds and log `logger.error({ err }, 'Slot verification circuit breaker tripped')`. Resume automatically after cooldown.
- **Dead letter**: After max retries, log the failed extraction context to a dead-letter table (`slot_verification_failures`) for operator review. The slot is left unfilled/flagged with `{ verified: false, error: 'verification_timeout' }`.
- **Operator notification**: Persistent failures (circuit breaker tripped) should surface in operational monitoring. Out of scope for this feature — raw diagnostics only (per spec Out of Scope).

## 5. Scoring Algorithm (FR-001, FR-002)

Deterministic scoring components:
1. **Exact Match**: Highest weight.
2. **Stemmed Match**: High weight (Porter stemmer).
3. **Synonym Match**: Medium weight (from funnel-defined synonyms).
4. **Stage Boost**: Current stage (+X), Next stage (+Y).
5. **Type Boost**: Objection handler boost when objection detected (simple keyword/regex or state).

- **Tiebreak**: Alphabetical by fragment ID (UUID string comparison) to ensure reproducibility (FR-002).
- **Query strategy**: Load ALL fragments for the pinned funnel version in a single batched query (filtered by `funnel_version_id`), then score in-memory. No per-stage loop — avoids N+1.

### Legacy Scoring Weight Defaults

These values are ported from the legacy Script Funnels engine and serve as the defaults for new funnels:

| Weight | Default Value | Description |
|--------|---------------|-------------|
| `exact_match` | 10 | Exact phrase match (case-insensitive, after normalization) |
| `stemmed_match` | 7 | Stemmed word match via PorterStemmerRu |
| `synonym_match` | 5 | Match via funnel-defined synonym groups |
| `stage_boost` | 3 | Bonus for fragments in the current stage |
| `next_stage_bonus` | 1.5 | Bonus for fragments in the natural next stage |
| `objection_boost` | 2 | Bonus for objection-type fragments when objection detected |
| `relevance_threshold` | 0.5 | Minimum normalized score to select a fragment (below → off-script) |
| `stuck_threshold` | 3 | Consecutive turns in one stage before safety-net fires |

All values are configurable per funnel via `config.scoring_weights` (see API contract).

## 6. Integration Hook (FR-021)

Hook into `ChatService.complete` **and** `ChatService.completeStream`.

```typescript
// Pseudocode integration
const funnelResult = await funnelService.processMessage(tenantId, personaId, conversationId, userMessage);
if (funnelResult.type === 'scripted') {
  // For complete: return funnelResult.scriptedReply directly
  // For completeStream: return scripted reply as a single-chunk SSE event + [DONE]
  return funnelResult.scriptedReply;
} else if (funnelResult.type === 'steer') {
  // Add funnel context (current stage goal, captured slots) to LLM prompt
}
```

**Streaming note**: When a scripted fragment is selected, `completeStream` returns it as a single-chunk SSE event (`data: ...`) followed by `[DONE]`. No streaming simulation needed — the reply is already fully formed.

## 7. Funnel Versioning Model (FR-016)

### Problem

FR-016 requires pinning in-flight conversations to their starting funnel version. A single mutable `funnels` row with an optimistic-lock `version` column cannot satisfy this: updating the row for v2 destroys v1's data.

### Decision

Split into two tables:

- **`funnel_definitions`**: Stable identity (id, tenant_id, persona_id, name, soft-delete). Never changes shape on publish.
- **`funnel_versions`**: Immutable snapshot per publish. Each `POST /v1/funnels` creates a new version row with an incremented `version_number`. Child tables (stages, fragments, slots) reference `funnel_version_id`, not the definition.

**Pinning**: `conversation_funnel_states.funnel_version_id` → the specific immutable version row. The conversation reads stages/fragments/slots via this FK. Publishing a new version creates new rows — the old ones are untouched.

**Active version**: `funnel_versions.is_active = true` marks the version that new conversations should adopt. Only one version per definition is active at a time (enforced by a partial unique index or application logic that deactivates the prior version on publish).

## 8. Caching Strategy for Hot Path

### Problem

Every `processMessage()` call needs the full funnel definition (version config + stages + fragments). Without caching, this is 3+ PG queries per turn.

### Decision

In-process LRU cache keyed by `funnel_version_id`:

| Aspect | Value |
|--------|-------|
| Key | `funnel_version_id` (UUID) |
| Value | Full denormalized funnel object (stages, fragments, slots, config) |
| TTL | Infinite (versions are immutable — cache entries never need invalidation) |
| Max size | 100 entries (typical: 1-10 active funnels per instance) |
| Eviction | LRU |
| Implementation | `lru-cache` npm package or simple `Map` with size guard |

For multi-instance deployments, Redis can serve as a shared L2 cache. Not needed initially — the immutability guarantee means each instance builds its own consistent cache.

**Cache miss path**: `SELECT funnel_versions JOIN funnel_stages JOIN funnel_fragments JOIN funnel_slots WHERE funnel_version_id = ?` → single batched query → populate cache.

## 9. Stage Resolution Criteria (FR-007, FR-025)

### Problem

"Advance when the current stage's objective is resolved" is the core transition trigger but had no machine-readable definition.

### Decision

Each stage defines `resolution_criteria` (JSONB, required) with one of:

| Type | Trigger | Example |
|------|---------|---------|
| `fragment_selected` | A specific "closing" fragment is selected | `{ "type": "fragment_selected", "fragment_id": "uuid" }` |
| `slot_filled` | A specific slot receives a verified value | `{ "type": "slot_filled", "slot_name": "user_budget" }` |
| `all_slots_filled` | All stage-scoped slots are filled | `{ "type": "all_slots_filled" }` |

The runtime evaluates resolution criteria after each fragment selection. If criteria are met, the conversation advances to `next_stage_id`.

## 10. Stage Regression Detection (FR-008)

### Problem

FR-008 requires stage regression but no detection algorithm was specified.

### Decision

**Score-based regression**: If the winning fragment belongs to a **different (earlier) stage** AND its score exceeds the best current-stage fragment's score by more than the `stage_boost` margin, transition to that earlier stage.

Rationale: The `stage_boost` exists to bias toward the current stage. If an earlier-stage fragment wins *despite* the boost, the conversation has genuinely moved backward (e.g., user re-raises a topic from stage 1 while in stage 3).

**Guard**: Regression resets `consecutive_stuck_count` to 0 (same as forward advancement) to prevent the safety-net from firing spuriously after a legitimate regression.

## 11. Concurrent Turn Serialization (FR-027)

### Problem

Two messages arriving near-simultaneously for the same conversation (double-send, webhook retry + real message) will both read stale state and produce conflicting updates.

### Decision

**Redis advisory lock** per `conversation_id` at the start of `processMessage()`:

- **Key**: `funnel:lock:{conversation_id}`
- **TTL**: 500ms (hot-path budget + safety margin)
- **Behavior**: If lock is held, the second message waits up to 200ms, then falls through to generation without funnel processing (safe degradation).
- **Implementation**: `SET funnel:lock:{conversation_id} 1 NX PX 500` via the existing `ioredis` dependency.

This serializes turns, guaranteeing deterministic behavior (SC-002). The lock is released at the end of `processMessage()` or on TTL expiry (whichever comes first).

## 12. Funnel Deletion Lifecycle (FR-023)

### Decision

**Soft-delete only** via `deleted_at` timestamp on `funnel_definitions`:

- In-flight conversations continue on their pinned `funnel_version_id` (immutable rows survive).
- New conversations treat the funnel as non-existent (no-op runtime path, same as FR-020).
- Soft-deleted funnels are excluded from `GET /v1/funnels` list responses.
- `GET /v1/funnels/:id` returns 404 for soft-deleted funnels.
- Hard-delete (purge) of old version data is a separate background cleanup job, out of scope for this feature.

## 13. Snapshot Isolation for Mid-Turn Consistency

### Decision

Load the full funnel definition **once** at the start of `processMessage()` and pass the in-memory object through the entire turn pipeline (scorer, stage controller, diagnostics). No re-reads from DB during the turn.

Combined with the immutable versioning model (§7), this guarantees that even if a new version is published mid-turn, the current turn uses a single consistent definition snapshot.
