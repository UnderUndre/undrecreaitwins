# Session: ResponseGuard call-site wiring + tests

## Done
- T012: Call-site 2 (buffered delivery) gated with `responseGuard.run()` `tier: 'deterministic-only'`
- T013: Call-site 3 (agentic language guard) gated with `responseGuard.run()` `tier: 'deterministic-only'`
- T042: Fail-open test + 3 other basic tests written and passing
- `tsc --noEmit` passes clean

## Key Decisions
- Call-site 3 uses full if/else (guard vs legacy) because the code path is structurally different (agent execution context)
- ResponseGuard test covers: happy path, full tier, deterministic-only tier, fail-open on DB error

## Artifacts
- `packages/core/src/services/chat-service.ts`: all 3 call-sites gated
- `packages/core/src/test/correction-rules/response-guard.test.ts`: 4 tests, all green

## Next
- T010 (shortCircuit), T011 (unified events), US3 (verdict mapping), US4 (terminalOnFail, latency)
