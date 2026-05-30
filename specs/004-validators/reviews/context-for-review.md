# Context for SpecKit Review: 004-validators

This document provides a technical snapshot of the current codebase and architectural state to assist AI reviewers in evaluating the `004-validators` specification without exhaustive codebase traversal.

## 1. Executive Summary
The `004-validators` feature ports legacy LLM-output validation logic into the modern TypeScript engine. It establishes a composable post-generation pipeline for non-streaming replies. Phase 1 targets: `false-promise`, `format-injection`, and `identity-and-provider-guard`.

## 2. Existing Architecture (Ground Truth)

### The Validator Pipeline
- **Orchestrator**: `server/services/supercompat/validator-chain.ts`. It executes an ordered sequence of validators.
- **Stages**:
  - Stage 1: **BLOCKING** (Parallel) - Aborts delivery on trigger.
  - Stage 2: **REWRITE** (Sequential) - Mutates response text.
  - Stage 3: **FLAG** (Async) - Background logging.
- **Unified Path**: `executeUnifiedValidation` (in `unified-validator.ts`) can batch multiple validators into a single LLM call if they share a model.

### The Registry System
- **Registry Location**: `server/services/validators/registry/`.
- **Mechanism**: Validators are defined as `ValidatorRegistryEntry` in `entries/*.ts`.
- **Dispatch Types**: `regex`, `llm-judge`, `schema-validator`, `handoff-rule`.
- **Bootstrapping**: `registry/bootstrap.ts` wires the LLM judge client to the `supercompat` provider manager.

## 3. Validator Specifics (Recon Results)

### Identity & Provider Guard (`identity-and-provider-guard.ts`)
- **Nature**: Deterministic regex-based.
- **Trigger**: Matches identity questions in `rawUserMessage` (e.g., "are you a bot?") or provider leaks in `responseText` (e.g., "I am an Anthropic model").
- **Regex Logic**: 
  - `IDENTITY_QUESTION_RE` handles Russian/English human/bot inquiries.
  - `RESPONSE_LEAK_RE` detects names like Claude, GPT, OpenAI.
- **Remediation**: `rewrite` action. Replaces the entire response with a template.
- **Fallback**: Default text is "Да, я ИИ-ассистент Анна. Если хотите, могу передать живому оператору 😊". [L32]

### False-Promise Validator
- **Planned**: Needs a deterministic prefilter to avoid unnecessary LLM calls.
- **LLM Judge**: Required to distinguish between "internal" promises (allowed) and "external" commitments to customers (blocked/disclaimer).

### Format-Injection Strip
- **Planned**: Pre-generation strip of control tokens and instruction-hijack artifacts.

## 4. Key Constraints & Data Points
- **Non-Streaming Only**: Current validators do not support streaming; tokens already sent cannot be blocked or mutated.
- **Latency Budget**: <10ms for clean passes; ~1500ms max for LLM-based checks.
- **Persistence**: `validator_runs` table logs audit data; `validator_configs` stores per-tenant/persona mode (`active`/`dry-run`).
- **Fail-Policy**: Fail-closed for EXACT matches, fail-open for AMBIGUOUS matches or judge errors.

## 5. Reference Paths
- `server/services/validators/identity-and-provider-guard.ts` (Existing logic)
- `server/services/supercompat/validator-chain.ts` (Chain orchestrator)
- `server/services/validators/registry/index.ts` (Registry entries)
- `server/services/response-validator.ts` (Legacy validator logic being replaced/consolidated)

## 6. Identified Risks for Reviewers
- **Composition Conflicts**: How 004-validators interacts with `003-script-funnels` (both hook into post-generation).
- **Empty Rewrite Guard**: Preventing validators from stripping all text and leaving an empty response.
- **Regex Greediness**: Risk of `stripMatch` collapsing valid replies to "residue".
- **Identity Policy Source**: Ensuring per-persona `fallbackMessage` correctly overrides the hardcoded default.
