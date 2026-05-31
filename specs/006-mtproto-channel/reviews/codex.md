# SpecKit Review: 006-mtproto-channel

**Reviewer**: codex
**Reviewed at**: 2026-05-31T12:08:15.8695822Z
**Commit**: e99be83c36ace84dfd85b9d893c3ca7d3c8d5284
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/mtproto-channel.ts, quickstart.md, research.md, reviews/context-for-review.md, .specify/memory/constitution.md, packages/shared/src/types.ts, specs/001-twin-engine-foundation/contracts/channel-adapter.interface.ts, packages/channel-telegram/src/telegram-adapter.ts, packages/channel-whatsapp/src/whatsapp-adapter.ts; Context7 GramJS docs for session-string/client initialization patterns.

## Summary

The feature names the right MTProto concerns: session strings, allowlists, FloodWait, and typing indicators. The problem is that the current artifacts stop at a happy-path client wrapper. They do not match the existing Engine channel contract, and they leave Telegram's hard runtime invariants, credential lifecycle, and update recovery as implementation guesses. That is not a channel adapter yet, just a faucet with no shutoff valves.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Engine contract | 006 defines and tasks implementation against a new `IChannelAdapter` with `onMessage`, `sendMessage(chatId, text)`, no `health()`, and a different `ChannelMessage` shape (`contracts/mtproto-channel.ts:10`-`15`). The repo already has the canonical `ChannelAdapter` in `@undrecreaitwins/shared` with `onIncoming`, `send(message)`, `health()`, and `ChannelMessage { channelId, externalUserId, content, timestamp: Date }` (`packages/shared/src/types.ts:97`-`102`). Existing Telegram/WhatsApp adapters implement that shared contract (`packages/channel-telegram/src/telegram-adapter.ts:2`-`6`, `packages/channel-whatsapp/src/whatsapp-adapter.ts:1`-`7`). Implementing 006 as written will not plug into the Engine. | Delete the local `IChannelAdapter` contract and make 006 extend/import `@undrecreaitwins/shared` `ChannelAdapter`. Map MTProto peer IDs into the canonical `ChannelMessage` fields, add `health()`, and update tasks/quickstart to use `onIncoming` and `send`. |
| F2 | HIGH | MTProto resynchronization | The review context explicitly asks for recovery after session interruption, but 006 declares no durable state and only in-memory `TelegramClient`, `typingTimers`, and `rateLimitQueue` (`data-model.md:3`, `data-model.md:19`-`22`). Tasks cover connect/listen/send/typing (`tasks.md:41`-`44`) but no `pts`/update-state checkpoint, replay window, idempotency key, duplicate suppression, or gap handling after reconnect. A crash or network split can drop updates, reprocess old messages, or trigger double LLM replies. | Specify a recovery strategy: persist or obtain update state from the MTProto library, record processed `{channelId, externalMessageId}` idempotency keys in shared storage, define reconnect replay behavior, and add tests for disconnect during inbound and outbound flows. |
| F3 | HIGH | Telegram rate limits / migration | FloodWait handling is reduced to "queue 50, drop if wait >60s" (`spec.md:16`, `plan.md:21`, `tasks.md:43`), while research says policy is still "potentially queuing or dropping" (`research.md:18`). It does not distinguish per-peer vs account-wide throttles, outbound vs typing RPC throttles, retry-after parsing, queue ordering, cancellation, or what `sendMessage` resolves/rejects with. The context also asks for migration handling, but no task covers `PHONE_MIGRATE`, `NETWORK_MIGRATE`, `USER_MIGRATE`, or DC reconnect/session rebind behavior. | Define a Telegram RPC error policy table: FloodWait scopes, max queue age, return semantics, typing throttles, DC migration handling, retry limits, and account-protection circuit breaker. Add unit tests for FloodWait short wait, >60s drop, queue overflow, migration retry, and non-retryable errors. |
| F4 | HIGH | Secret and auth-key lifecycle | The plan says storage is N/A because the session string is provided dynamically (`plan.md:16`) and only promises secrets will not be hardcoded (`plan.md:31`). But `apiHash` and `sessionString` are accepted directly in options (`contracts/mtproto-channel.ts:3`-`5`, `data-model.md:10`-`12`), and Product stores the session string (`spec.md:21`). There is no contract for encryption-at-rest, redaction, rotation/revocation, invalid-session handling, or avoiding logs/metrics that include session values. Session strings are bearer credentials for a real user account. | Add a security contract with Product: encrypted session storage, secret injection by reference or secret handle where possible, redacted structured logging, explicit logout/revoke flow, invalid/expired session errors, and tests that config/options/errors never serialize `apiHash` or `sessionString`. |
| F5 | HIGH | Runtime topology / shared transport | Existing channel adapters are standalone packages that publish inbound and consume outbound messages via shared transport/Redis Streams (`packages/channel-telegram/src/telegram-adapter.ts:35`-`44`, `packages/channel-telegram/src/telegram-adapter.ts:58`-`82`). 006 instead says the Engine "raises the client and handles `newMessage`" (`spec.md:11`) and the quickstart calls the channel directly in-process (`quickstart.md:27`-`42`). The plan never decides whether MTProto is an Engine-embedded adapter or a separate worker like current channels, so deployment, scaling, tenant/channel identity, backpressure, and crash isolation are undefined. | Pick one topology. If standalone, reuse `ChannelTransport` and canonical adapter process conventions. If embedded, document why MTProto is the exception, how many user sessions can run per process, how tenant/channel IDs are bound, and how crashes are isolated from the core API. |
| F6 | MEDIUM | Message filtering / loop prevention | The allowlist is `allowedChats?: (string | number)[]` (`contracts/mtproto-channel.ts:6`), but userbot updates include private chats, groups, channels, self/outgoing messages, edits, service messages, forwards, and replies. The spec only says "filter needed chats/users" (`spec.md:15`) and tasks only mention allowlist filtering (`tasks.md:42`). There is no rule to ignore own outbound messages, already-processed edits, empty/media-only updates, or channel posts that can create reply loops and token burn. | Define inbound eligibility precisely: peer type, sender vs chat allowlist precedence, ignore outgoing/self messages, edit handling, media-only behavior, service messages, and normalized peer ID format. Add tests for loop prevention and mixed allowlist cases. |
| F7 | MEDIUM | Test coverage | Only one test task exists before implementation, and it covers initialization plus allowlist filtering (`tasks.md:37`). There are no required tests for FloodWait/backoff, DC migration, reconnect/replay, duplicate inbound updates, secret redaction, typing timer cleanup, disconnect while queued, or invalid session strings. | Expand T006 or split tests by risk: protocol errors, recovery/idempotency, secret handling, lifecycle cleanup, and contract compatibility with `@undrecreaitwins/shared` `ChannelAdapter`. |
| F8 | LOW | Package naming / install docs | The quickstart imports `@ai-twins/channel-telegram-mtproto` (`quickstart.md:15`), while existing packages use `@undrecreaitwins/*` (`packages/channel-telegram/package.json:2`, `packages/channel-whatsapp/package.json:2`). This will mislead implementation and consumers. | Use the monorepo naming convention, likely `@undrecreaitwins/channel-telegram-mtproto`, and mirror existing package metadata/scripts. |

## Alternative approaches considered

1. Extend the existing `@undrecreaitwins/channel-telegram` package with an MTProto mode while preserving the shared `ChannelAdapter` and Redis Streams transport.
2. Keep a separate `channel-telegram-mtproto` package, but make it a drop-in `ChannelAdapter` worker with the same process/transport contract as Telegram Bot API and WhatsApp.
3. Let Product own all login/session lifecycle and give the adapter only a channel instance ID plus a secret-handle resolver, not raw session material in broad config objects.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: codex
reviewed_at: 2026-05-31T12:08:15.8695822Z
commit: e99be83c36ace84dfd85b9d893c3ca7d3c8d5284
critical_count: 1
high_count: 4
medium_count: 2
low_count: 1
```
