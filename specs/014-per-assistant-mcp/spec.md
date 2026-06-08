# Feature Specification: Per-Assistant MCP Servers (Brokered)

**Feature Branch**: `specs/014-per-assistant-mcp`
**Created**: 2026-06-08
**Status**: Draft
**Input**: User description: per-assistant MCP servers in Hermes profiles — let each assistant get extra external tools (GitHub, calendar, CRM, internal APIs) via MCP, configured per assistant. Backend in `undrecreaitwins`; admin UI in `ai-twins`.

## Context *(why this exists)*

Spec 010 (Hermes Executor) gives every agentic turn **one** toolset: the engine-hosted MCP **gateway** ([mcp-server.ts](../../packages/core/src/services/hermes/mcp-server.ts) + [tool-gateway.ts](../../packages/core/src/services/hermes/tool-gateway.ts)), passed as the single `session/new.mcpServers` entry ([hermes-executor.ts:266](../../packages/core/src/services/hermes/hermes-executor.ts)). That gateway is the **sole authority** for tools: allow-list + per-tenant write-permission + idempotency + audit + dry-run/confirm. It is the sole authority *by necessity* — 010 T000a verified ACP **auto-approves** tool calls (`session/request_permission` never fires), so anything the agent can reach, it can call unchecked.

Today there is **no way to give a specific assistant extra tools.** Assistant A can't get a GitHub MCP and assistant B a calendar MCP. This feature adds per-assistant external MCP servers.

**The trap this spec exists to avoid.** The naïve implementation — drop external MCP servers straight into `session/new.mcpServers` — **bypasses the gateway entirely**: external tools would run with no allow-list, no per-tenant permission, no audit, no dry-run, plus SSRF and secret-exfil surface. That deletes 010's threat model. So this feature **brokers** external MCP through the gateway: the engine connects to registered external MCP servers as a *client*, then **re-exposes** their tools through its own MCP gateway, applying the identical controls. The agent only ever sees the gateway.

## Clarifications

### Session 2026-06-08
- **CQ1 — trust model → Tenant-admin self-serve.** Tenant admins register registered HTTP MCP servers into their own tenant-scoped catalog; assistants toggle entries. Risk contained by SSRF-pin + secret encryption + RLS. Free-form per-assistant URLs rejected. (FR-001)
- **CQ2 — exposure → Broker through the gateway.** Engine connects to external MCP as a client and re-exposes tools through its own gateway with full controls; no raw `session/new` passthrough. Preserves 010. (FR-004)
- **CQ3 — external writes → Full write-treatment.** External write tools get the same reserve→execute→finalize idempotency + per-persona permission + confirm/dry-run + audit as native (010 T015) — NOT read-only. ⚠ Larger blast radius: the broker must route external mutations through the full write-action machinery. (FR-011)
- **CQ4 — transport → HTTP for tenants; stdio platform-admin only.** Tenant entries are HTTP-only; stdio (command exec) is allowed solely on platform-admin entries, RCE-gated, never settable from tenant config. (FR-006)

### Session 2026-06-08 (review remediation — opencode + gemini, both HIGH)
- **SSRF**: pin resolved IP, connect to the IP not the hostname (DNS-rebinding) — FR-005 (opencode F1).
- **Un-classified tool**: defaults to **write-treatment** (`isWriteAction:true`), not read-only — closes double-execute — FR-011 (opencode F2 / analyze F3).
- **External-write idempotency is best-effort at the engine boundary** — engine can't make a black-box mutation idempotent; admin UX must say "make your write tools retry-safe" — FR-011 (gemini F1).
- **Tool-name limits**: validate `entry.name` so synthesized `mcp_<entry>_<tool>` stays ≤64 char / provider regex — FR-010 (gemini F2).
- **Binding tenant-match** CHECK/composite-FK + broker JOIN on tenant_id — FR-008 (opencode F5).
- **Parallel discovery** + **max response size** — FR-013/FR-014 (gemini F3/F4, opencode F6/F11).
- "vetted" → "registered" (no approval workflow exists — opencode F7); T010 split + `T009→T010` edge (analyze F1/F2, opencode F3/F4).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator curates + binds MCP servers to an assistant (Priority: P1)

As an **operator/tenant-admin**, I register a registered external MCP server once and enable it on a specific assistant, so that assistant gains those tools — scoped to my tenant.

**Why this priority**: nothing else works without the config layer. It's also where the security boundary is set (what's allowed to exist at all).

**Independent Test**: register a catalog entry (HTTP url + optional auth + tool include/exclude + timeout) and bind it to a persona; confirm it persists tenant-scoped, the auth secret is encrypted (never returned/logged in plaintext), and a different tenant cannot see or bind it.

**Acceptance Scenarios**:

1. **Given** a tenant-admin, **When** they register an HTTP MCP server with auth headers, **Then** the entry is stored tenant-scoped and the secret is encrypted at rest (reusing 011's KMS envelope).
2. **Given** a registered entry, **When** an admin enables it on persona X with a tool include-list, **Then** persona X is bound to that entry with the tool filter; persona Y is unaffected.
3. **Given** a URL pointing at a private/loopback address, **When** registration is attempted, **Then** it is rejected by the SSRF egress policy.

---

### User Story 2 - Agent uses brokered MCP tools under full gateway control (Priority: P1)

As an **end-user** of an MCP-enabled assistant, the assistant can actually use the extra tools during a turn — and every such call is governed exactly like a native tool.

**Why this priority**: this is the payload. Without it, US1 is config that does nothing.

**Independent Test**: on an agentic turn for an MCP-bound persona, a tool from the external server is offered to the agent, a call to it routes **through the engine gateway** (permission-checked + audited), and a server that is *not* bound is never reachable.

**Acceptance Scenarios**:

1. **Given** persona X bound to a registered MCP server, **When** an agentic turn runs, **Then** the engine connects to that server, discovers its tools (respecting include/exclude), and re-exposes them through the engine gateway alongside native tools.
2. **Given** the agent calls a brokered tool, **When** the call executes, **Then** it passes the same allow-list + per-tenant permission + audit + write-action treatment (idempotency/confirm/dry-run for writes) as a native tool — never a direct un-brokered MCP entry.
3. **Given** an external tool result containing a prompt-injection payload, **When** it returns, **Then** it stays wrapped in the `<untrusted_tool_result>` fence (010 §i defense preserved).

---

### User Story 3 - Resilience + isolation (Priority: P2)

As an **operator**, a flaky external MCP must not break turns, and one tenant's MCP config/secrets must never leak to another.

**Why this priority**: makes it safe to run in prod, but the slice delivers value (US1+US2) before this is hardened.

**Independent Test**: kill a bound external MCP mid-turn → turn still completes (its tools unavailable, logged); attempt cross-tenant read → denied; bound URL that resolves to a private IP at connect-time → blocked.

**Acceptance Scenarios**:

1. **Given** a bound MCP server that is down/slow, **When** a turn runs, **Then** its tools are simply unavailable (logged + health signal), the turn proceeds with remaining tools; it does **not** fail the turn.
2. **Given** two tenants, **When** each binds servers, **Then** neither tenant can read the other's catalog entries, secrets, or bindings (Postgres RLS).
3. **Given** repeated turns for the same persona, **When** tool discovery runs, **Then** discovery is cached (TTL) — no per-turn N+1 against the external server.

---

### Edge Cases

- **stdio MCP** = command execution = RCE → forbidden from tenant config; allowed **only** on platform-admin entries (CQ4).
- **Tool-name collisions** (external↔native, across servers) → namespaced `mcp_<server>_<tool>`.
- **Catalog server exposing 100 tools** → context/token blow-up → include/exclude + a per-binding tool cap.
- **Secret rotation / expired MCP auth** → connect fails → degrade (US3), surfaced for re-config.
- **External MCP advertises a write tool** → runs through the full write-action machinery (idempotency/confirm/audit) — CQ3.
- **MCP `resources`/`prompts`** (hermes can consume them, not just tools) → out of scope v1 (tools only).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A **tenant-admin** MUST be able to register MCP catalog entries into their tenant-scoped catalog (HTTP url, optional auth headers, per-server tool include/exclude, timeout, TLS verify); assistants toggle from it. Free-form per-assistant URLs are NOT permitted. (CQ1)
- **FR-002**: System MUST let an assistant (persona) be bound to zero or more catalog entries, with an optional per-binding tool include/exclude override.
- **FR-003**: External MCP auth secrets MUST be encrypted at rest (reuse 011 KMS envelope) and MUST NOT be returned via API or written to logs in plaintext.
- **FR-004**: At an agentic turn, the engine MUST broker the assistant's enabled external MCP tools **through the engine MCP gateway** — applying the same allow-list, per-tenant write-permission, audit, and dry-run/confirm as native tools. The agent MUST NOT receive a direct external `mcpServers` entry that bypasses the gateway. (CQ2: broker confirmed.)
- **FR-005**: External MCP URLs MUST pass the SSRF egress policy (reuse 011 DNS-resolve-and-pin via undici dispatcher) at **both** registration and connect time; private/loopback blocked unless explicitly allow-listed. The engine MUST **connect to the IP resolved during validation (pinned), not re-resolve the hostname** at call time — closing the DNS-rebinding window (registration sees a public IP, connect hits `127.0.0.1`). (opencode F1)
- **FR-006**: Tenant-scoped entries MUST be **HTTP only**. **stdio** (command execution) MUST be settable **only on platform-admin entries** (RCE-gated) and MUST NOT be configurable from tenant config. (CQ4)
- **FR-007**: An unreachable/slow external MCP MUST degrade gracefully — its tools become unavailable for that turn (logged + health signal), the turn proceeds; it MUST NOT fail the turn.
- **FR-008**: Per-tenant isolation — a tenant MUST NOT read or use another tenant's catalog entries, secrets, or bindings (Postgres RLS via `withTenantContext`). A binding MUST reference a catalog entry of the **same tenant**, enforced at the **DB layer** (CHECK / composite-FK `binding.tenant_id = entry.tenant_id`) — not by RLS alone — and the broker query JOINs on `tenant_id` (defence-in-depth against a write-path bug inserting a cross-tenant binding). (opencode F5)
- **FR-009**: Brokered tool results MUST preserve the `<untrusted_tool_result>` fencing (prompt-injection defense, 010 §i).
- **FR-010**: Tool names MUST be disambiguated by namespacing `mcp_<entry>_<tool>` across native + all external servers. Catalog `entry.name` MUST be validated at registration (`^[a-z0-9_-]+$`, ≤ 20 chars) so the **synthesized** name stays within LLM-provider limits (≤ 64 chars, `^[a-zA-Z0-9_-]+$`); a tool whose synthesized name would exceed the limit MUST be rejected (or deterministically truncated), never sent to the provider raw. (gemini F2)
- **FR-011**: External tools that mutate state MUST receive the **full write-action treatment** — reserve→execute→finalize idempotency (composite-unique key), per-persona permission, confirm/dry-run for high-stakes, and audit — identical to native write tools (010 T015). External writes are NOT read-only. (CQ3) **Guarantee scope (gemini F1)**: this makes the **engine-side dispatch** idempotent (no replay/double-dispatch of the same key); it CANNOT make the *external* mutation idempotent — a connection drop mid-`execute` may leave the external system changed without a finalize. So it is **best-effort at the engine boundary**, and the admin UX MUST tell tenant-admins their external write tools should be retry-safe. **Un-classified external tools default to write-treatment (`isWriteAction:true`)** until an admin classifies them — never silently read-only (closes the double-execute hole — opencode F2 / analyze F3).
- **FR-012**: Config and runtime MUST be observable: bound servers per persona, per-turn connection health, brokered tool-call audit entries.
- **FR-013**: External tool discovery MUST be cached (TTL, keyed by server) to avoid per-turn N+1 against external servers (echoing the 013 honcho N+1 lesson). On a cache miss across multiple bound entries, discovery MUST run **concurrently** (bounded `Promise.allSettled`), not sequentially, so a multi-server persona doesn't serialize connect latency into turn start. (gemini F3 / opencode F6)
- **FR-014**: The MCP client MUST enforce a **max response size** (e.g. 1 MB) on `tools/list` and `tools/call` — an oversized response aborts the stream and marks the entry degraded, preventing OOM from a hostile/buggy server. (gemini F4 / opencode F11)

### Key Entities *(include if feature involves data)*

- **MCP Catalog Entry** — tenant-scoped (per CQ1): name, transport (http), url, encrypted auth (headers), tool include/exclude, timeout, TLS verify, enabled. New Drizzle table → reviewed `.sql` migration (Standing Order 5).
- **Assistant MCP Binding** — persona ↔ catalog entry (enabled), optional per-binding tool override.
- **Brokered Tool** — a discovered external tool surfaced through the engine gateway, namespaced, carrying the gateway's permission/audit metadata. Runtime only (not persisted).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A persona bound to a registered MCP server invokes its tool in a turn, and **100%** of brokered calls pass through the gateway (audited + permission-checked); **0** direct un-brokered calls.
- **SC-002**: A down/slow bound MCP causes **0** turn failures (tools unavailable, degraded) and is visible in health/logs.
- **SC-003**: **0** cases where a tenant can read/use another tenant's MCP config or secrets.
- **SC-004**: A private-IP/disallowed URL is rejected at **both** registration and connect (SSRF) in **100%** of attempts.
- **SC-005**: Per-turn external tool discovery issues **≤ 1** discovery call per (server, TTL window) — no N+1.

## Out of Scope

- **Admin UI** — the catalog CRUD + per-assistant toggle screens live in Product (`ai-twins`), per the engine↔admin split (like 011). This spec (engine) owns the **runtime broker + config API + storage + RLS**.
- MCP `resources`/`prompts` consumption (tools only, v1).
- Sub-agent config, hermes hooks, native-toolset toggles, per-assistant loop/execution budgets — separate future specs (surfaced in the prior gap analysis, intentionally deferred).
- *(stdio transport is in scope but **platform-admin-only**, CQ4 — not a tenant-facing feature.)*

## Dependencies & Assumptions

- **Depends on** spec 010 (engine MCP gateway, tool-gateway, mcp-server) — this feature extends it, not forks it.
- **Reuses** spec 011 infrastructure: KMS envelope encryption (secrets) + SSRF DNS-resolve-and-pin (undici dispatcher).
- **Cross-repo**: admin UI is `ai-twins` (next to the existing assistant LLM-provider admin, [`apps/web/src/pages/api/assistants/[id]/llm-provider.js`](../../../ai-twins/apps/web/src/pages/api/assistants/[id]/llm-provider.js)); engine exposes the config API it drives.
- **Assumes** hermes-agent consumes external MCP via its `mcp_servers` config / ACP `session/new.mcpServers` (verified: http + stdio transports, tool include/exclude, timeout, TLS — [hermes MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)). The broker model means we use hermes' MCP client *for the engine→external hop only if needed*; the agent→engine hop stays the single gateway entry.
