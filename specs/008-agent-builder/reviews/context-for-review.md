# Context for SpecKit Review: 008-agent-builder

## Overview
Infrastructure and tooling for programmatic creation and configuration of agents.

## Artifacts to Review
- `specs/008-agent-builder/spec.md`
- `specs/008-agent-builder/plan.md`
- `specs/008-agent-builder/tasks.md`

## Lens for Review
- Focus on template validation and schema integrity for new agent definitions.
- Assess isolation and security of the agent building process.
- Evaluate idempotency of builder scripts and deployment state.

## Review Instructions
Please conduct an adversarial review focusing on:
1. Potential for malicious agent injection or configuration drift.
2. Error handling and rollback mechanisms for failed builds.
3. Security of exported agent configurations (secret handling).
