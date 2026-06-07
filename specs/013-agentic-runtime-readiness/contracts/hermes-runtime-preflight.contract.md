# Contract: Hermes Runtime Preflight

**Scope**: a startup check (`packages/core/src/services/hermes/hermes-preflight.ts`, invoked from engine boot / `buildServer()` readiness in `packages/api`). Turns the current first-turn `spawn ENOENT` into a boot-time, typed failure. (FR-001, FR-002, FR-003)

## Trigger

Runs once at engine startup, **before** the server reports ready/healthy. Gated to the agentic path: only enforced when the agentic executor is enabled (so a deploy with agents off isn't blocked by a missing Hermes).

## Procedure

1. Read `HERMES_ACP_CMD` (already required by `HermesExecutor`); split into `cmd` + `args`.
2. Resolve `cmd` on PATH. Unresolvable → fail `hermes_missing`.
3. Run `hermes acp --check` (verified OK in spec 010 §i) with a short timeout.
   - non-zero exit / timeout → fail `check_failed`.
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
- **AC4**: agents-disabled deploy → preflight skipped, engine starts normally.
