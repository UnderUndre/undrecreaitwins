# Research: 006 MTProto Channel

## 1. Library Evaluation: GramJS vs MTKruto

**GramJS**:
- **Pros**: Most mature MTProto client for Node.js/TypeScript. Extensive documentation and community support. Good session string implementation.
- **Cons**: Can be heavy; sometimes slow to update to the latest layer.

**MTKruto**:
- **Pros**: Modern, built for Deno but supports Node/Bun. Very fast, uses latest MTProto layers. Clean API.
- **Cons**: Less mature ecosystem compared to GramJS.

**Decision**: We will proceed with **GramJS** due to its stability in Node.js environments and widespread usage for userbot scenarios, making rate limit handling and session string parsing more predictable. If MTKruto is preferred by the team, the `TwinChannel` abstraction ensures the underlying library can be swapped out without affecting the Engine.

## 2. Rate Limiting (FloodWait)

Telegram strictly enforces rate limits on user accounts (more strictly than bot API). 
- **Handling**: When a `FloodWaitError` is encountered, the adapter must extract the wait time and pause message sending for that specific channel/chat, potentially queuing or dropping messages depending on the Engine's policy.

## 3. Typing Indicators

Telegram requires sending a specific RPC call to show "Typing...". Since LLM generation can take several seconds, the adapter needs to emit this status periodically (e.g., every 4 seconds) until the generation stream completes.

## 4. Message Filtering

Userbots receive *all* messages from all dialogs. To prevent the Engine from being overwhelmed and wasting LLM tokens:
- The adapter must accept an allowlist of chat IDs or user IDs.
- Only messages from allowed sources will be forwarded to the Engine as `newMessage` events.
