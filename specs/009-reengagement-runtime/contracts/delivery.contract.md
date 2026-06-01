# Contract: Hook Delivery

## Purpose
Hand off the generated hook to the appropriate channel adapter via Redis.

## Operation: `deliver(attemptId)`
1. Fetch `FollowupAttempt` (must be in `processing` status).
2. Fetch corresponding `conversation`.
3. Construct `REDIS_STREAMS.OUTBOUND` payload:
   - `channel_id`: `conversation.channelId`
   - `external_user_id`: `conversation.externalUserId`
   - `content`: `generatedHook`
   - `tenant_id`: `attempt.tenantId`
   - `message_id`: `attempt.id` (idempotency reference)
4. Publish to Redis.
5. Update `FollowupAttempt.status = 'sent'`.

## Invariants
- **Idempotency (FR-009)**: Never publish to Redis twice for the same `attemptId`. Use a local Redis lock or atomic `status` update check.
- **Address Integrity**: Ensure `externalUserId` and `channelId` match the conversation exactly.
- **Latency (SC-002)**: p95 from `scheduled` to Redis `publish` must be < 2 seconds.
