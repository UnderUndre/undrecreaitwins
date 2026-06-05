# Research: 012-openai-endpoint (Engine)

## Clarifications
1. **Key Format**: Prefix sk-aitw- + 32-byte random hex string.
2. **Hashing**: Using node:crypto with PBKDF2 or scrypt for hashing keys at rest.
3. **Tenant Context**: The auth-public middleware will inject tenantId into the request context based on the key's workspace.
4. **Chat Persistence**: OpenAI clients are stateless. The engine will derive a threadId from the client's session/user or use a provided one to ensure Honcho memory and conversation history work correctly.

## Assumptions
- The existing ChatService in packages/core or packages/api is generic enough to be called from the new public route.
- isTestThread flag is already supported by the internal pipeline for sandbox mode.
