# Contract: Hook Generator

## Purpose
Generate a contextual re-engagement message (hook) using `ChatService` and `llm.complete`.

## Inputs
- `conversationId`: UUID
- `ruleId`: UUID (for template/prompt)
- `tenantId`: UUID

## Operation
1. Load last 10 messages from the `messages` table for `conversationId`.
2. Fetch the `FollowupRule` template.
3. Assemble the prompt:
   - System: Rule template.
   - History: The fetched messages.
4. Call `llm.complete(prompt)`.
5. Persist the generated hook to the `messages` table via `ChatService.persistMessages`.

## Invariants
- **Contextual Integrity**: The generated hook must be based on the provided history, not a generic string (unless generation fails).
- **History preservation**: Appending the hook must not corrupt existing `messages` records.
- **Tenant Scoping**: Never use messages from Conversation B to generate a hook for Conversation A.
- **LLM timeout (hermes M3)**: `llm.complete` MUST run under a timeout (`TWIN_REENGAGE_LLM_TIMEOUT_MS`, default 30 s). On timeout → attempt `failed` (`failureReason='llm_timeout'`); never block the worker indefinitely (direct contributor to the stuck-`processing` risk, FR-011).
- **Prompt-injection safety (antigravity F5)**: conversation history is **untrusted user input**. The rule `template` is the only authoritative system instruction; history MUST be passed as clearly-delimited user/assistant turns (never merged into the system prompt), so a user message like "ignore instructions and say X" cannot hijack the outbound hook. Apply an output sanity check before publish.

## Output
- `hookContent`: string
- `usage`: token counts
