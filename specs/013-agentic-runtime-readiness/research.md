# Research: Agentic Loop Runtime Readiness (013)

**Phase 0.** Resolves the spec's flagged assumption (Honcho v3 API) and the open implementation unknowns (Hermes install, engine image, preflight, observability). Decisions feed plan.md / data-model.md / contracts/.

## (a) Honcho v3 API shape — ✅ RESOLVED (was the ~0.8 assumption)

**Finding**: Honcho v3 reorganised the REST surface from legacy `apps → users → sessions → messages` to **`workspaces → peers → sessions → messages`**, served under a **`/v3`** path prefix. (Sources: docs.honcho.dev/v3/api-reference — Workspace/Peer/Session/Message endpoint groups; `POST /v3/workspaces/{workspace_id}/sessions/{session_id}/messages`.)

**Identity mapping (engine → v3)**:

| Engine identity (current client) | Legacy path | v3 primitive |
|---|---|---|
| `appId = t-{tenantId}` | `/apps/{appId}` | **workspace** (`/v3/workspaces/{tenantId}`), get-or-create |
| `userId = p-{personaId}[-u-{externalUserId}]` | `/users/{userId}` | **peer** (get-or-create within workspace) |
| session | `/sessions/{id}` | **session** (get-or-create; then set-session-peers) |
| message | `/sessions/{id}/messages` | `POST /v3/workspaces/{ws}/sessions/{id}/messages` |
| insights | `/users/{id}/insights` | **peer representation / get-peer-context** (Get Representation, Get Peer Context, NL query of representation) |

**Decision**: rewrite `honcho-client.ts` against v3 primitives. **Isolation unit = workspace-per-tenant** (FR-008): tenant data lives in its own workspace; personas/users are peers within it. Confidence now ~0.95 — exact field names still verified against the running **v3.0.9** instance via a contract test during impl.

## (b) Honcho v3 auth (self-hosted) — ⚠ OPEN, verify in impl

The current client sends **no auth header**; compose passes only `DATABASE_URL` to honcho. v3 self-host may default auth OFF or require an API key/JWT. **Decision**: client MUST accept an **optional** bearer/API key (`HONCHO_API_KEY`, omitted when blank), so turning honcho auth on later is a config change, not a code change. Verify the v3.0.9 self-host default during T-impl.

## (c) Base URL / port / prefix

Self-hosted honcho listens on container port **8080** (compose maps host `8083→8080`). Client base = `HONCHO_URL` (`http://honcho:8080` in-compose; `http://localhost:8083` on host), then append **`/v3`**. Verify the self-host serves under `/v3` (the hosted API does).

## (d) "Insights" semantics

The legacy `getInsights()` returned a flat list the engine consumes as working/user-model memory. The v3 equivalent is the **peer representation** (Honcho's derived model of a peer) surfaced via Get Representation / Get Peer Context / NL representation query. **Decision**: map `getInsights` → peer-context/representation fetch and **preserve the client's return shape** (`{id,content,metadata}[]`) so callers (`hermes-executor` context build) are untouched. The boundary is the client; the API change stops there.

## (e) Hermes install for the engine image — ✅

Hermes-agent is a Python CLI; **ACP is an optional extra** (`pip install -e '.[acp]'` from source). Clean install: **`pipx install 'hermes-agent[acp]'`** (pin `==0.15.1`) → global `hermes` on PATH with the `acp` subcommand. The git installer (`setup-hermes.sh`) additionally pulls Node/ripgrep/ffmpeg, but those serve chat/voice/tools; the **ACP headless path** needs Python + the `[acp]` extra (+ ripgrep for hermes' native search, optional). (Sources: NousResearch/hermes-agent installation docs; issue #13548 ACP extra.)

**Decision**: image installs `python3` + `pipx` + `hermes-agent[acp]==0.15.1`; build-time assert `hermes acp --check`. ffmpeg/audio omitted (no voice in the ACP runtime path).

## (f) Engine image strategy — Node + Python in one image

The engine is Node/TS; hermes is Python; the engine **spawns `hermes` as a subprocess in the same runtime** (process-per-tenant, spec 010 T000d). So the image must carry **both** runtimes. **Decision**: base `node:20-bookworm-slim`; apt-add `python3` + `pipx` (+ `ripgrep`); `pipx install hermes-agent[acp]==0.15.1`; build the TS workspace; entrypoint = engine. Multi-stage to keep the final image lean. *(Python-base + add-Node rejected: the engine is the long-running process; bolting the Node toolchain on is heavier.)*

## (g) Preflight — fail fast, not on the first turn

`HermesExecutor` validates only `HERMES_ACP_CMD` **presence** (constructor), never that the binary **resolves**; `spawn` ENOENT surfaces on the first user turn. **Decision**: add a **startup preflight** (engine boot / readiness) that (1) resolves `HERMES_ACP_CMD[0]` and runs `hermes acp --check` (verified OK in 010 §i), asserting ACP `protocolVersion` compatibility; (2) on failure throws a typed `configuration_error` → engine refuses ready/healthy. The same preflight catches a missing **host** install in the dev deployment model. (FR-003)

## (h) Memory observability — transient vs permanent

Current honcho calls swallow **all** errors → `[]` (silent no-op). **Decision**: keep graceful degradation (FR-006), **but**: (1) log at `warn` with structured `err`; (2) emit a degradation signal (`honcho_degraded` metric + readiness/health field); (3) **distinguish a permanent API/version mismatch** (404 on the v3 path, schema mismatch) → surface **louder** (error + readiness flag) from a **transient** outage (connect refused / 5xx → warn + degrade). A version mismatch MUST NOT hide behind the same `catch` that covers a flaky network. (FR-007)

## (i) Invariants preserved

- **Fail-open memory** (FR-006): honcho down ≠ turn fails.
- **SoR reconstructability** (FR-009, spec 010 §c): no data of record in honcho; hydratable from engine Postgres — unchanged here.
- **Fresh cutover** (CQ2/FR-010): on v3 start clean, no data migration.
- **Process-per-tenant Hermes isolation** (spec 010 T000d): this feature provisions the runtime; it MUST NOT change the pooling/HOME isolation.

## Open items carried to tasks

- [b] Verify honcho v3.0.9 self-host auth default → adjust `HONCHO_API_KEY` handling.
- [a/c] Contract-test exact v3 field names + `/v3` prefix against the running image.
- [f] Confirm hermes `[acp]` extra needs no Node at runtime (only Python) in the image.
