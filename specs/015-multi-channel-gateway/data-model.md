# Phase 1 Data Model — Multi-Channel Gateway

> twin-engine (`@undrecreaitwins/*`). Extends existing contracts; backward-compatible.

## ChannelMessage (extend — `packages/shared/src/types.ts`)

Existing: `{ id, channelId, externalUserId, content, metadata?, timestamp }`.
**FR-001 additions (all OPTIONAL → text-only telegram/whatsapp unaffected):**

| Field | Type | Note |
| --- | --- | --- |
| `attachments?` | `Array<{ kind: 'image'\|'audio'\|'video'\|'file'; url?: string; bytes?: Buffer; mime: string; filename?: string }>` | US2 media |
| `typing?` | `boolean` | typing signal; graceful no-op on channels without it |
| `replyAnchor?` | `{ externalMessageId: string }` | reply/thread anchor |

## ChannelType (extend union — `packages/shared/src/types.ts`)

Existing: `'telegram' \| 'whatsapp_evolution'`. **Add (Phase 1)**: `discord`, `slack`,
`mattermost`, `dingtalk`, `feishu`, `wecom`. **(Phase 2)**: `matrix`, `email`, `sms`,
`webhook`, `homeassistant`. Update `channel-orchestrator.ts` `extractChannelType()` allow-set
+ `VALID_CHANNEL_TYPES`.

## channel_instances (extend — `packages/core/src/models/channel-instances.ts`)

Existing: `config: jsonb` (holds creds **plaintext** — gap). **P0-2/FR-004 change:**

| Field | Type | Note |
| --- | --- | --- |
| `credentialsCiphertext` | text/bytea | encrypted creds via `KmsProvider` (mirror `llm_provider_config.apiKeyCiphertext`) |
| `kmsKeyVersion` | string/int | KMS key version used — enables rotation without ambiguity (glm-F10) |
| `config` (jsonb) | — | keep ONLY non-secret display/config; secrets move to ciphertext |

**Migration (Standing Order 5 — review .sql, no auto-exec)**: add column + backfill existing
plaintext `config` secrets → encrypt → ciphertext; scrub secrets from `config`. **Safety (gemini-F3)**:
verify decrypt round-trips ДО scrub plaintext (no-data-loss); миграция идемпотентна/re-runnable; no plaintext-window.

## INBOUND payload (existing, per `channel-orchestrator.ts`)

`{ channel_id, message_id, persona_slug, content, tenant_id, external_user_id, channel_type? }`.
Adapters stamp `tenant_id`+`persona_slug` (held per-instance). Extend with attachment refs for media.

## OUTBOUND payload (existing)

`{ channel_id, message_id, reply_to, content, tenant_id, external_user_id }` | `{…, error }`.
Adapter consumes filtered by `channel_id`, sends, acks after success (R6).

## Per-adapter config (per channel package)

Each `channel-<x>` constructor takes `{ tenantId, personaSlug, transport, ...creds }` (decrypted
from `credentialsCiphertext` at provision). `inboundMode: 'bot' | 'socket' | 'webhook'` declared
by adapter (FR-008). Webhook adapters carry signature secret + verifier.

## Validation rules

- Webhook inbound: verify signature via shared `webhook-signature.ts` (HMAC-SHA256 + constant-time, glm-F3) BEFORE INBOUND publish; invalid → discard + log (FR-006). Idempotency: Redis `seen:<channel>:<message_id>` SET NX + TTL drops redelivered webhooks (gemini-F4).
- Platform limits encoded via shared `channel-rate-limiter.ts` (per-platform msgs/sec, length, media-size; glm-F8) — adapters call `rateLimiter.check()` before send; values ported from Hermes `base.py`. (Telegram UTF-16, WhatsApp 24h window, LINE 60s token.)
- Creds: never in env, never plaintext at rest, never logged (Standing Order 4 / FR-004); rotation re-encrypts + reconnects, `kmsKeyVersion` tracks key (glm-F10).
- `health()` returns `ChannelHealth` (`active|degraded|disconnected|error`) — surfaced per-channel + aggregated `GET /api/channels/health` (`{ channels, overall }`, tenant-scoped, ~30s poll cached in Redis; glm-F7) (FR-005).
- OUTBOUND consumer: runtime-assert no `stream:true`/`partial:true` payload (CL-A7 executable, glm-F9); adapter crash before send → `XPENDING` idle-timeout (`XPENDING_IDLE_MS` default 5 min) redelivery, monitor pending > threshold (glm-F5).
