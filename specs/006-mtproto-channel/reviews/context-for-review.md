# Context for SpecKit Review: 006-mtproto-channel

## Overview
MTProto communication channel integration for Telegram messaging.

## Artifacts to Review
- `specs/006-mtproto-channel/spec.md`
- `specs/006-mtproto-channel/plan.md`
- `specs/006-mtproto-channel/tasks.md`

## Lens for Review
- Focus on MTProto-specific failure modes (FLOOD_WAIT, migration).
- Assess security of auth key storage and rotation.
- Evaluate resynchronization logic after session interruption.

## Review Instructions
Please conduct an adversarial review focusing on:
1. Compliance with Telegram's rate-limiting/migration requirements.
2. Secure secret/key management practices.
3. Resilience of the session and message sequence recovery.
