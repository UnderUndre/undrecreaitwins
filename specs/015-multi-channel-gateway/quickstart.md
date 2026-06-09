# Quickstart / Validation — Multi-Channel Gateway (015)

> Run in twin-engine (`undrecreaitwins`) after a channel package lands. Proves the spec's
> acceptance without reading code.

## Preconditions

- twin-engine up (orchestrator consuming `twin.stream.in`, Redis + Postgres reachable).
- **Gate-0 done**: reengagement validator fix merged (CL-A6), channel creds encrypted (CL-A1).
- Two tenants T1/T2 provisioned; a persona per tenant.

## S1 — New channel replies through the gate (US1, MVP)

1. Provision a Discord channel for (T1, personaA) with a bot token (stored encrypted).
2. Send a message to the Discord bot.
3. **Verify**: inbound normalized → `twin.stream.in` with `tenant_id=T1`, `persona_slug=A`;
   orchestrator runs `chatService.complete()` (validators 004); reply → `twin.stream.out` →
   adapter sends to Discord. Same validator path as Telegram. ✅ US1.

## S2 — Tenant isolation (NFR Isolation)

1. T2 also has a Discord channel. Send to both concurrently.
2. **Verify**: T1 reply uses T1 persona/creds only; zero cross-tenant; creds never appear in logs
   (encrypted at rest, decrypted only in-process). ✅

## S3 — Media in/out (US2)

1. Send an image to a Slack/Discord channel; twin replies with an attachment.
2. **Verify**: `ChannelMessage.attachments[]` populated inbound + outbound; text-only Telegram
   path still works unchanged (backward-compat). ✅ US2.

## S4 — Webhook signature (US3)

1. POST a forged-signature payload to the Feishu/WeCom webhook adapter.
2. **Verify**: discarded + logged, NOT published to INBOUND. Valid signature → published. ✅ US3.

## S5 — Gate integrity (CL-A6, gate-0)

1. Trigger a reengagement message on a new channel.
2. **Verify**: it passed `validateResponse()` before OUTBOUND (post-fix). No unvalidated egress. ✅

## S6 — Resilience (FR-007)

1. Kill an adapter process mid-run.
2. **Verify**: its `health()` → `'error'`; orchestrator + other channels unaffected; on restart,
   Redis Streams ack → no lost/duplicated messages. ✅

## Quality gates

- Per-package `vitest` integration tests green (incl. tenant-isolation + signature + media).
- No `as any` / `console.log` / plaintext creds / raw `throw` in new adapters (twin-engine standards).
- New per-channel deps installed only after explicit approval (Standing Order 2).
