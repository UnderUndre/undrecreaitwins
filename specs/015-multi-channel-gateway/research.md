# Phase 0 Research — Multi-Channel Gateway

> Target codebase = twin-engine (`undrecreaitwins`, TS). Most architecture already exists
> (verified 2026-06-09 audit). Research resolves the deltas, not the foundation.

## R1 — Foundation already exists (no unknown)

**Decision**: reuse as-is. `ChannelAdapter` contract (`specs/001-twin-engine-foundation/
contracts/channel-adapter.interface.ts`), `ChannelMessage`, `ChannelTransport` (Redis streams
`twin.stream.in`/`twin.stream.out`), `ChannelOrchestrator` (INBOUND→`chatService.complete()`→
OUTBOUND + dedup via Redis SET NX), validators 004 in `chat-service`. Each adapter is its own
process (`channel-telegram/index.ts --bot-token`) stamping `tenant_id`/`persona_slug`.
**Rationale**: confirmed by code read; adding a channel = the existing telegram pattern.

## R2 — Gate-0: sole-gate premise is FALSE today (CL-A6)

**Decision**: close before scaling. `reengagement/delivery.ts:49` publishes raw `llm.complete()`
output (`generator.ts:52`) to OUTBOUND, skipping `validateResponse()`. Must route through
validators. **In progress as a separate twin-engine bug-fix (chip).** 015 depends on it
(gate-0 prerequisite) — scaling 13 channels over an open gate multiplies unvalidated egress.
**Alternatives rejected**: scale first, fix later — multiplies blast radius; per-adapter
validation — wrong layer (validators belong in the brain, not adapters, per DD-HX-001).

## R3 — Channel credential storage (CL-A1 / FR-004)

**Decision**: reuse the **KMS primitive** (`core/services/llm-provider/crypto.ts` —
`KmsProvider`/`LocalKmsProvider`/`VaultKmsProvider`, `encryptApiKey/decryptApiKey`), add a
`credentialsCiphertext` column to `channel_instances` (mirror `llm_provider_config.apiKeyCiphertext`).
Current state: creds **plaintext** in `channel_instances.config` jsonb. **In progress as a
twin-engine bug-fix (chip)** incl. backfill migration. **Alternatives rejected**: new secret
store (dup of crypto.ts), env-only (breaks multitenant, Standing Order 4).

## R4 — Inbound transport per channel (CL-A3 / FR-008)

**Decision**: adapter declares its mode.
- **bot/socket** (outbound WS, no public URL per-tenant): Discord (Gateway WS, `discord.js`),
  Mattermost, DingTalk, Matrix (`matrix-js-sdk`).
- **webhook** (signature-verified before INBOUND publish, FR-006): **Slack (Events API + HMAC,
  один эндпоинт, роутинг по `team_id` — CL-A13/glm-F18)**, Feishu, WeCom, MS Graph, generic Webhooks.
  Signature verify in the adapter, in TS (not trusted to an external fork), общий `webhook-signature.ts`.
**Rationale**: parity with Telegram long-poll; multitenant-friendly; smaller attack surface.
**Alternatives rejected**: all-webhook (needs public per-tenant endpoints + routing).

## R5 — ChannelMessage extension (FR-001 / US2)

**Decision**: extend `packages/shared/src/types.ts` — `ChannelType` union (+ discord/slack/
mattermost/dingtalk/feishu/wecom/matrix/email/sms/webhook/homeassistant) and `ChannelMessage`
with optional `attachments[]`, `typing` signal, `replyAnchor`. **Backward-compatible** (optional
fields) — telegram/whatsapp text-only unaffected. **Alternatives rejected**: separate precursor
spec (CL-A4 — overhead); breaking change (would touch existing 2 channels).

## R6 — Dedup / ack semantics (edge cases)

**Decision**: keep existing Redis Streams consumer-group + dedup (`dedup:<channel>:<message_id>`
SET NX, `DEDUP_TTL_SECONDS`). Adapters must ack OUTBOUND only after successful platform send to
avoid loss; redelivery dedup guards against double-send. **Open**: confirm each new adapter's
send is idempotent-safe under redelivery (platform-specific) — per-adapter integration test.

## R7 — Hermes = reference, not runtime (DL-2 / CL-A5)

**Decision**: read Hermes `gateway/platforms/<x>.py` for protocol quirks (length limits, token
expiry, signature schemes) and re-implement in TS. Do NOT import/fork. Note: twin-engine already
has `core/services/hermes/` (executor/guardrail) — that's agent-execution, unrelated to channel
gateway; don't conflate. **Alternatives rejected**: Python sidecar (CL-A5 Option C) — niche only.
**Pin (glm-F12)**: Hermes — живой репозиторий; зафиксировать commit SHA эталона
(`HERMES_REF_SHA = <TODO: pin actual SHA at implement-time>`) и читать квирки против пиннутой
версии, не HEAD. При имплементе каждого адаптера сверять подпись/лимиты с пиннутым SHA — иначе
адаптер строится против устаревшего референса.

## R8 — Consumer-process sprawl (gemini-F5 / glm-F6) — research spike (post-MVP)

**Decision (deferred to spike, not v1)**: each adapter = its own Node process (~50 MB RSS) →
15 channels ≈ 750 MB baseline before traffic. For small deployments this is wasteful. **Spike
after T007 resource-profiling**: evaluate coalescing low-traffic channels (DingTalk, Mattermost,
Home Assistant) into one process with internal routing (or `worker_threads`), while high-traffic
channels (Telegram, Discord, WhatsApp) stay standalone. **Trade-off**: lower memory vs. one crash
taking down co-tenants + harder debugging. **Not a v1 blocker** — flagged so it isn't silently
dropped; gate on profiling numbers.

## Summary

| Unknown | Resolution |
| --- | --- |
| Foundation | exists, reuse (R1) |
| Sole gate | false today → gate-0 fix in progress (R2) |
| Creds | KMS primitive + new ciphertext column, fix in progress (R3) |
| Inbound mode | per-adapter bot/socket vs webhook (R4) |
| ChannelMessage | extend shared, backward-compat (R5) |
| Dedup/ack | reuse streams + per-adapter idempotency test (R6) |
| Hermes | reference only (R7) |
