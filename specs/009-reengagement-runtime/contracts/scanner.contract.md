# Contract: Re-engagement Scanner

## Purpose
Identify dormant conversations matching `FollowupRule` criteria and schedule `FollowupAttempt` rows.

## Invariants
- **Multi-tenant isolation**: A scan for Tenant A must never see or affect conversations/rules of Tenant B.
- **Dormancy accuracy**: A conversation is dormant if `now() - last_message_at > rule.triggerStaleMinutes`.
- **Anti-spam**: No more than `rule.maxAttempts` per conversation/rule cycle.
- **Backoff respect**: No new attempt if `now() - lastReengagementAt < backoff[reengagementCount]`.
- **Exclusion**: Skip conversations with `optedOut = true`, status `closed`, or human-handled (operator-assigned) conversations.
- **No open-attempt re-scan (FR-012)**: Skip conversations that already have an open (`scheduled`/`processing`) `FollowupAttempt` for the rule — never re-fetch a stuck/pending row (prevents batch poisoning).
- **Cross-rule minInterval (FR-006)**: Skip if `now() - lastReengagementAt < rule.minIntervalMinutes`; schedule **at most one** attempt per conversation per scan even if multiple rules match.
- **Backoff overflow**: when `reengagementCount ≥ len(backoff)`, use the last `backoff` element.
- **Conditions (FR-002)**: apply `rule.conditions` per the data-model Conditions schema as extra filters.

## Operation: `runScan(tenantId)`
1. Fetch all active `FollowupRule` for `tenantId`.
2. For each rule, batch query `conversations` where:
   - `tenantId` matches.
   - `needsReengagement = true`.
   - `optedOut = false`.
   - status NOT IN (`closed`) AND not human-handled (no active operator assignment).
   - NO open (`scheduled`/`processing`) `FollowupAttempt` exists for (conversation, rule) [FR-012].
   - `now() - lastReengagementAt >= rule.minIntervalMinutes` [FR-006 cross-rule].
   - matches `rule.conditions` (Conditions schema) [FR-002].
   - `lastMessageAt <= now() - triggerStaleMinutes`.
   - **De-dup across rules**: collapse candidates so at most ONE attempt is scheduled per conversation per scan.
3. For each candidate:
   - Compute `cycleIndex = reengagementCount` and `idempotencyKey = convId:ruleId:cycleIndex`.
   - If `reengagementCount < rule.maxAttempts` AND `outside_backoff_window`:
     - Insert `FollowupAttempt` with `status='scheduled'` via `ON CONFLICT (idempotencyKey) DO NOTHING` — the UNIQUE constraint is the dedup guard (NO check-then-insert).

## Performance Contract (SC-004)
- Handle 10k conversations per run.
- Use `FOR UPDATE SKIP LOCKED` or similar if multiple scanners run, to avoid double scheduling.
- Batch size: 1000 records.
