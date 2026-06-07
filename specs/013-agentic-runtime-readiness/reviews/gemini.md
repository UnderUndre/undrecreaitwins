# SpecKit Review: 013-agentic-runtime-readiness

**Reviewer**: gemini
**Reviewed at**: 2026-06-07T00:00:00Z
**Commit**: HEAD
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, quickstart.md, research.md, constitution.md

## Summary

The specification thoroughly addresses the critical runtime gaps (missing Hermes CLI and Honcho v3 drift) with a clear, parallelizable execution plan and excellent focus on graceful degradation. However, the runtime provisioning strategy contains a hidden Python version mismatch, the Dockerfile plan risks PATH/permission issues with `pipx`, and the Honcho client rewrite introduces a potential severe N+1 API call amplification without caching. Additionally, a hanging preflight subprocess could indefinitely brick engine startup.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Failure modes | The `hermes acp --check` startup preflight described in `hermes-preflight.ts` (T005) lacks a specified timeout. If the Python subprocess hangs indefinitely (e.g., due to an OS issue, interactive prompt, or missing dependency loop), `buildServer()` will block forever, silently preventing the engine from starting. | Add a strict timeout (e.g., `5000ms`) to the `spawn` or `exec` call in `hermes-preflight.ts`. If it times out, throw the `check_failed` error so the engine fails fast. |
| F2 | HIGH | Logical consistency | `plan.md` specifies "Python 3.12 for the Hermes CLI bundled in-image", but `packages/api/Dockerfile` (T004) uses `node:20-bookworm-slim` and `apt-add python3`. Debian Bookworm's default repository provides Python 3.11, not 3.12. | If Hermes 0.15.1 strictly requires Python 3.12, you must use a different installation method (like the deadsnakes PPA or `uv`) or a different base image. If Python 3.11 is acceptable, update the plan to reflect reality. |
| F3 | HIGH | Security / Docker | `pipx install` places binaries in `~/.local/bin` of the executing user. If the Dockerfile installs hermes as `root` but the engine runs under a restricted `node` user (standard Node image practice), the `node` user will not have `hermes` on its `PATH` and may lack read/execute permissions. | Explicitly define `PIPX_HOME` and `PIPX_BIN_DIR=/usr/local/bin` during the Dockerfile build, or ensure the `pipx install` command is executed as the `node` user and that `~/.local/bin` is appended to `ENV PATH`. |
| F4 | HIGH | Performance & scale | `plan.md` (T010) states `get-or-create workspace/peer/session` before posting a message. Performing these 3 distinct API calls before every single memory interaction will cause severe N+1 latency amplification against the Honcho v3 backend, slowing down every agentic turn unnecessarily. | Implement an in-memory LRU cache (or Map) in `HonchoClient` to store resolved workspace, peer, and session IDs per tenant. Skip the `get-or-create` calls on subsequent operations if the IDs are already cached. |
| F5 | HIGH | Edge case | Concurrency race condition on `get-or-create`: if two turns for a new tenant arrive simultaneously, both might issue a `POST` to create the same workspace/peer. If Honcho v3 enforces unique names and returns a `409 Conflict`, one of the turns will fail to write memory. | Ensure `HonchoClient`'s creation logic catches a `409 Conflict` (or equivalent "already exists" error) and seamlessly falls back to a `GET` request to retrieve the newly created resource ID. |

## Alternative approaches considered

Instead of a heavy multi-stage Docker build utilizing `pipx` and full Python environments on top of Node, consider using `uv` (Astral's fast Python package installer) which drastically reduces build times and manages virtual environments in a highly predictable way for containers. This would simplify `PATH` injection and speed up the CI pipeline.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: gemini
reviewed_at: 2026-06-07T00:00:00Z
commit: HEAD
critical_count: 1
high_count: 4
medium_count: 0
low_count: 0
```
