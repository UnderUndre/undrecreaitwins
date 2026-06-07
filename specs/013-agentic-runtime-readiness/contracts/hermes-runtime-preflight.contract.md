# Contract: Hermes Runtime Preflight

**Scope**: a startup check (`packages/core/src/services/hermes/hermes-preflight.ts`, invoked from engine boot / `buildServer()` readiness in `packages/api`). Turns the current first-turn `spawn ENOENT` into a boot-time, typed failure. (FR-001, FR-002, FR-003)

## Trigger

Runs once at engine startup, **before** the server reports ready/healthy. Governed by an explicit predicate **`AGENTIC_EXECUTOR_ENABLED`** (a single documented config in compose/host — NOT inferred from persona data): when true the preflight is enforced; when false it is skipped and the engine starts normally (so an agents-off deploy isn't blocked by a missing Hermes). (codex F4)

## Procedure

1. Parse `HERMES_ACP_CMD` with a **shared parser/normalizer reused by `HermesExecutor`** (NOT an ad-hoc local split) → `{cmd, args}`. The normalizer handles absolute paths, wrappers, and quoted args so preflight checks the **same** executable the runtime spawns. (codex F6)
2. Resolve `cmd` on PATH. Unresolvable → fail `hermes_missing`.
3. Spawn the **configured** `cmd` with `acp --check` (verified OK in spec 010 §i) under a **strict 5 s timeout**.
   - non-zero exit OR timeout → fail `check_failed` — MUST never block boot. (gemini F1)
4. Assert the reported ACP `protocolVersion` is compatible with the adapter (`protocolVersion 1`).
   - mismatch → fail `acp_incompatible`.
5. All pass → `{ ok: true, resolvedCommand, acpProtocolVersion }`.

## Result contract

```ts
type PreflightResult =
  | { ok: true; resolvedCommand: string; acpProtocolVersion: number }
  | { ok: false; error: { code: 'hermes_missing' | 'acp_incompatible' | 'check_failed'; message: string } };
```

On `ok: false` the engine MUST throw `AppError(message, 500, 'configuration_error')` (or fail readiness) — it MUST NOT start accepting turns. The error message MUST name the dependency and the failing reason (actionable), e.g. `"Hermes preflight failed: 'hermes' not found on PATH (HERMES_ACP_CMD='hermes acp --accept-hooks')"`.

## Non-goals

- Does NOT change spawn/pooling/HOME isolation (spec 010 T000d) — only verifies availability + compatibility.
- Does NOT verify the LLM provider (011) — separate concern.

## Acceptance

- **AC1**: correctly provisioned runtime (container or host) → preflight passes, engine ready. (SC-001)
- **AC2**: `hermes` absent / unresolvable → engine fails at boot with an actionable typed error; **0** turns attempted. (SC-002, FR-003)
- **AC3**: incompatible Hermes (ACP protocol mismatch) → `acp_incompatible` at boot, not mid-conversation. (FR-002)
- **AC4**: `AGENTIC_EXECUTOR_ENABLED=false` (or the deploy default) → preflight skipped, engine starts normally. Conversely enabled+missing Hermes → fail (AC2); enabled+compatible → pass (AC1). (codex F4 test matrix)
- **AC5**: a hung `hermes acp --check` → `check_failed` within ~5 s; boot never hangs. (gemini F1)
- **AC6**: `HERMES_ACP_CMD` with an absolute path / quoted args → preflight checks the same executable the executor spawns (shared parser). (codex F6)
