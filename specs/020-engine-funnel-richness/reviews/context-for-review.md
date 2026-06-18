# Context for Review: Engine Funnel Richness (020)

This document provides architectural context for external AI reviewers (Gemini, Antigravity, Copilot, etc.) to perform `/speckit.review`.

## 1. Feature Core
We are upgrading the Funnel Runtime to support high-fidelity, human-like scripted interactions. The system must guarantee certain phrases are delivered verbatim while allowing others to be fluidly generated or templated.

## 2. Key Architectural Decisions

### Sync Post-Turn Slot Extraction
Extraction of user data (phone, email, intents) happens **synchronously after the response is generated but before the turn is finalized**.
- **Why?** Deterministic guards (`requiredSlots`) for the *next* turn must see updated state immediately.
- **Latency impact?** Zero user-facing latency, as it runs after the reply is sent to the channel adapter.

### Global Rerun Budget (FR-026)
We are introducing multiple generative steps: Adaptive Intro -> Main Gen -> Guards (Banned Words, Anti-Repeat).
- **Control**: A `maxTurnReruns = 2` cap prevents infinite loops and cost spikes.
- **Fail-safe**: If the budget is exhausted, the system falls back to "best-effort" delivery or a human handoff signal.

### Delivery Cascade (P1)
- `verbatim`: Literal text, skip LLM.
- `template`: Variable substitution `{{slot}}`, skip LLM.
- `llm`: Standard generation.

## 3. Review Focus Areas

- **LIFO Stack for Anytime Stages**: Review the logic for `returnStack` in `ConversationFunnelState`. Does it handle nested anytime triggers safely?
- **Pacing Metadata**: We recommend `delay_ms` and `typing_chunks` to channel adapters. Is the formula in `research.md` robust for both short and long messages?
- **Hybrid Intent Detection**: Affirmative advance and Anytime triggers use a Keyword-First -> LLM-Fallback pattern. Is the fallback correctly accounted for in the turn budget?
- **Backward Compatibility**: Ensure existing funnels (without new fields) continue to work in `llm` mode by default.

## 4. Referenced Files
- `spec.md`: User stories and functional requirements.
- `plan.md`: Technical stack and project structure.
- `data-model.md`: Drizzle schema extensions.
- `tasks.md`: Detailed implementation roadmap.
- `contracts/metadata.md`: Response metadata structure.
