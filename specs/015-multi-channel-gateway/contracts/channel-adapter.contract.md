# Contract — ChannelAdapter (extended) + stream payloads

> Extends the existing `@undrecreaitwins/shared` `ChannelAdapter` interface. New channels MUST
> implement it unchanged in shape; extensions are additive + backward-compatible.

## ChannelAdapter (unchanged 5-method shape)

```ts
interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onIncoming(handler: (m: ChannelMessage) => Promise<void>): void;
  send(message: ChannelMessage): Promise<void>;
  health(): Promise<ChannelHealth>;
}
```

**Lifecycle (per provisioned channel process):** instantiate with `{ tenantId, personaSlug,
transport, creds, inboundMode }` → `connect()` → on inbound: normalize to `ChannelMessage`,
stamp `tenant_id`/`persona_slug`, publish INBOUND → consume OUTBOUND (filter `channel_id`) →
`send()` → ack after success. `disconnect()` tears down.

## inboundMode (FR-008 / CL-A3)

- `'bot' | 'socket'`: outbound WS, no public URL (Discord Gateway, Slack Socket, Matrix, Mattermost, DingTalk).
- `'webhook'`: HTTP inbound; adapter MUST verify signature via shared `packages/core/src/services/webhook-signature.ts` (HMAC-SHA256 + constant-time compare, ported once from Hermes — glm-F3, NOT re-implemented per adapter) before INBOUND publish (Feishu, WeCom, MS Graph, generic). Invalid signature → discard + log (FR-006). Idempotency: Redis `seen:<channel>:<message_id>` SET NX + TTL drops redelivered webhooks before publish (gemini-F4).

## ChannelMessage (extended — see data-model.md)

Adds optional `attachments[]`, `typing`, `replyAnchor`. Channels lacking a capability → graceful
no-op (don't throw). Platform length/window limits enforced in adapter (port from Hermes ref).

## INBOUND publish (to `twin.stream.in`)

`{ channel_id, message_id, persona_slug, content, tenant_id, external_user_id, channel_type, attachments? }`

## OUTBOUND consume (from `twin.stream.out`)

`{ channel_id, message_id, reply_to, content, tenant_id, external_user_id }` or `{ …, error }`.
Adapter sends only its `channel_id`; acks after platform send confirms (no-loss); redelivery
deduped upstream. **Crash-window (glm-F5)**: if the adapter dies after consume but before `send`,
XACK never fires → the message sits in `XPENDING` until idle-timeout (`XPENDING_IDLE_MS`, default
5 min) → redelivered to another consumer. Crash within the send-window = delayed delivery, NOT
loss; monitor pending > threshold. **Guard (CL-A7, executable, glm-F9)**: the streaming guard runs at
OUTBOUND **publish** in `channel-orchestrator.ts` **and** in each adapter's OUTBOUND consumer — note the
orchestrator is the OUTBOUND *publisher* (INBOUND consumer); the **adapters** are the OUTBOUND consumers
(gemini). Either point runtime-asserts no `stream:true`/`partial:true` payload — log error + discard (not
just a documentary guard); never stream partial tokens to a channel.

## health() → ChannelHealth

`{ status: 'active'|'degraded'|'disconnected'|'error', lastPingAt?, error?, uptimeSeconds? }`.
Surfaced per-channel in API (FR-005). Adapter crash → status `'error'`, engine stays up (FR-007).
**Aggregation API (glm-F7)**: `GET /api/channels/health` → `{ channels: Record<channelId, ChannelHealth>,
overall: 'healthy'|'degraded'|'down' }`, tenant-scoped; collected via ~30s poll, cached in Redis.

## Credentials

Provided decrypted at construction from `channel_instances.credentialsCiphertext` (KmsProvider).
Never from env, never logged (FR-004 / Standing Order 4).

## Provisioning (glm-F4)

Channels are provisioned via an engine-side flow `channel-provisioning.ts` (NOT ad-hoc CLI args
like `channel-telegram --bot-token`): accept `{ tenantId, personaSlug, channelType, credentials,
config }` → encrypt creds via `KmsProvider` → write `channel_instances` (`credentialsCiphertext`
+ `kmsKeyRef`) → signal adapter `connect()`. This is the engine counterpart of the 016 canon
route `POST /api/assistants/[id]/channels` (016 T013) — they share this contract.

## Rate-limit (glm-F8)

Adapters call shared `channel-rate-limiter.ts` `check(channelType, payload)` before `send`
(per-platform msgs/sec, message length, media size; values ported from Hermes `base.py`). A
channel that doesn't enforce limits can get the bot banned — limiting is cross-cutting, not
duplicated per adapter.

## Rotation (glm-F10)

`rotateChannelCredentials(channelId, newCreds)`: re-encrypt with the new KMS key → update
`channel_instances` (`kmsKeyRef`) → signal adapter disconnect/reconnect so new connections
use the new secret while old ones drain. Zero-downtime rotation for a compromised key.
