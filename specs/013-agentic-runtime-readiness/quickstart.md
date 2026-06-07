# Quickstart: Agentic Loop Runtime Readiness (013)

Deploy the stack and verify both stories. Two deployment models are supported (CQ1).

## Prerequisites

- Standalone-compose image-namespace fix applied (honcho → `ghcr.io/plastic-labs/honcho:v3.0.9`; dead `hermes-agent` service removed). Done on this branch.
- `.env` filled from `infra/.env.example` (`HONCHO_URL`, `HERMES_ACP_CMD`, `LLM_PROVIDER_URL`, `LLM_API_KEY`; `HONCHO_API_KEY` only if honcho auth is enabled).

## Model A — Container (prod-like, one command)

```bash
# Build the engine image (Node + Python + hermes-agent[acp]==0.15.1) and start the stack
docker compose -f infra/docker-compose.standalone.yml up -d --build

# 1. Preflight (US1): engine must reach healthy — a missing/incompatible hermes fails HERE, not on first turn
docker compose -f infra/docker-compose.standalone.yml logs twin-engine-api | grep -i "preflight"
curl -fsS http://localhost:8090/v1/health        # expect healthy

# 2. Agentic turn (US1): an agent-enabled turn completes (no spawn ENOENT)
#    → send a message that routes to the agentic path; expect a streamed answer + stopReason: end_turn

# 3. Memory round-trip (US2): a fact stated on one turn is recalled on a later turn
#    → state a fact, then ask for it back; expect recall reflecting the stored fact

# 4. Isolation (US2): two tenants cannot read each other's memory (distinct honcho workspaces)
```

## Model B — Host (dev)

```bash
# Hermes on the host (documented prerequisite)
pipx install 'hermes-agent[acp]==0.15.1'
hermes acp --check                                # must print OK

# Only infra in docker; engine runs on host
docker compose -f infra/docker-compose.standalone.yml up -d postgres redis honcho tei-embed tei-rerank
cd packages/api && npm run dev                    # engine boot runs the same preflight
```

## Degradation checks (US2, FR-006/007)

```bash
# Stop honcho → turns still complete, degradation is VISIBLE (not silent)
docker compose -f infra/docker-compose.standalone.yml stop honcho
#  → run a turn: it succeeds (no memory); logs show "honcho degraded (transient)" + honcho_degraded signal
docker compose -f infra/docker-compose.standalone.yml start honcho
```

## Success criteria mapping

| Step | SC |
|---|---|
| 1 preflight healthy / fails at boot | SC-001, SC-002 |
| 2 agentic turn completes | SC-001 |
| 3 memory round-trip | SC-003 |
| 4 cross-tenant isolation | SC-004 |
| degradation visible with honcho down | SC-005 |
