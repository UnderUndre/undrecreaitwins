# Quickstart: Per-Assistant MCP Servers (014)

Verify the brokered per-assistant MCP slice. Requires the 010 agentic loop wired (013 US3) + a reachable external HTTP MCP server for the smoke.

## 1. Register a catalog entry (tenant-admin)

```bash
curl -X POST http://localhost:8090/v1/mcp/catalog \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-ID: $TENANT" -H "Content-Type: application/json" \
  -d '{ "name":"gh", "transport":"http", "url":"https://mcp.example.com", "auth":{"Authorization":"Bearer ..."} }'
# → 201; response has has_auth:true, NO secret echoed
```

- A `url` resolving to a private/loopback IP → **rejected** (SSRF). (SC-004)
- `transport:"stdio"` from a tenant token → **ValidationError**. (FR-006)

## 2. Discover + classify tools

```bash
curl -X POST .../v1/mcp/catalog/$ID/rescan -H ...   # → { tools: [...] }
```

Admin marks which tools are writes (`isWrite`) in the binding.

## 3. Bind to an assistant

```bash
curl -X PUT .../v1/assistants/$PERSONA/mcp -H ... \
  -d '{ "bindings":[{ "catalog_entry_id":"'$ID'", "enabled":true, "tool_overrides":[{"name":"create_issue","isWrite":true}] }] }'
```

## 4. Run an agentic turn → brokered tool used

Send a non-scripted message to the bound persona. Verify in `action_audit`:
- the external tool ran as `mcp_gh_<tool>`, **through the gateway** (audited, permission-checked). (SC-001)
- a write tool (`create_issue`) shows reserve→execute→finalize + idempotency. (FR-011)

## 5. Resilience + isolation checks

```bash
# Kill the external MCP → run a turn: completes, its tools absent, mcp_broker_degraded logged (SC-002)
# Second turn → no extra tools/list (cache hit) (SC-005)
# As tenant B, GET tenant A's entry → 404 (SC-003)
```

## Success criteria mapping
| Step | SC |
|---|---|
| 1 SSRF reject | SC-004 |
| 4 brokered + audited | SC-001 |
| 4 write-treatment | FR-011 |
| 5 degrade | SC-002 |
| 5 cache | SC-005 |
| 5 isolation | SC-003 |
