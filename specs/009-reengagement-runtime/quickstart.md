# Quickstart: Re-engagement Runtime (009)

## Setup Environment
Ensure your `.env` has:
```bash
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://...
REENGAGEMENT_SCAN_INTERVAL=1 # every 1 minute for testing
```

## Running the Scanner Locally
1. **Seed Data**:
   - Create a `FollowupRule` in the shared database (Prisma or Drizzle).
     - `triggerStaleMinutes: 5`
     - `maxAttempts: 3`
     - `template: "Hey, are you still there?"`
   - Create a `Conversation` with `lastMessageAt` = 10 minutes ago.
2. **Start the Engine Worker**:
   ```bash
   npm run dev:worker # should include ReengagementWorker
   ```
3. **Trigger Scan**:
   - The scanner should pick up the conversation automatically within the next minute.
4. **Observe Logs**:
   - Check `FollowupAttempt` table: status should transition `scheduled` -> `sent`.
   - Check Redis: `xread COUNT 1 STREAMS outbound $` should show the hook message.

## Verification Checklist
- [ ] Attempt created in `FollowupAttempt` table.
- [ ] Hook content generated contextually (if message history exists).
- [ ] Redis outbound stream received the message.
- [ ] `lastReengagementAt` updated on the conversation.
