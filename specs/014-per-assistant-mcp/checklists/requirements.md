# Requirements Quality Checklist — 014-per-assistant-mcp

**Stage**: specify + clarify (complete) · **Date**: 2026-06-08

## Content purity
- [x] WHAT/WHY, not HOW — broker mechanics + table DDL deferred to plan
- [x] Security boundary stated as the central concern (gateway = sole authority)

## Completeness
- [x] User stories prioritized (US1 P1 config, US2 P1 runtime broker, US3 P2 resilience/isolation), independently testable, with AC
- [x] FR-001..FR-014 present and testable (FR-014 payload cap added in review remediation)
- [x] Measurable SC-001..SC-005
- [x] Edge cases (stdio RCE, collisions, tool blow-up, secret rotation, write tools, resources/prompts)
- [x] Out-of-Scope + Dependencies (010 extend, 011 reuse, ai-twins admin)

## Grounding (verified this session)
- [x] Today only the engine gateway is passed to session/new (hermes-executor.ts:266 `mcpServers:[mcpEntry]`) — no per-assistant external MCP
- [x] ACP auto-approves tool calls (010 T000a) → gateway must stay sole authority → broker, not raw passthrough
- [x] hermes mcp_servers config surface (http/stdio, include/exclude, timeout, TLS) — confirmed via docs
- [x] 011 provides KMS encryption + SSRF pin to reuse
- [x] ai-twins has per-assistant admin pattern (assistants/[id]/llm-provider)

## Clarifications (resolved — Session 2026-06-08)
- [x] CQ1 → **Tenant-admin self-serve** catalog (SSRF-pin + encrypt + RLS contain risk; free-form rejected) (FR-001)
- [x] CQ2 → **Broker through gateway** — full controls, preserves 010 (FR-004)
- [x] CQ3 → **Full write-treatment** for external write tools (idempotency/confirm/audit, 010 T015) — ⚠ larger blast radius (FR-011)
- [x] CQ4 → **HTTP for tenants, stdio platform-admin-only** (RCE-gated) (FR-006)

## Known flags / risks (carry to plan)
- [ ] SSRF + secret-exfil is the dominant risk surface — registration AND connect-time enforcement
- [ ] Tool-count explosion → context blow-up (include/exclude + cap)
- [ ] New DB tables → reviewed `.sql` migration only (Standing Order 5)
- [ ] Cross-repo admin (ai-twins) coordination

## Review remediation (2026-06-08 — analyze + opencode + gemini, full-write kept)
- [x] SSRF pin-to-IP / DNS-rebinding → FR-005 (opencode F1)
- [x] Un-classified tool → write-treatment default (not read-only) → FR-011 (opencode F2 / analyze F3)
- [x] External-write idempotency = best-effort at engine boundary → FR-011 (gemini F1)
- [x] Tool-name limits (`entry.name` regex+len, synthesized ≤64) → FR-010 (gemini F2)
- [x] Binding↔entry tenant-match CHECK + broker JOIN → FR-008 (opencode F5)
- [x] Parallel discovery + max payload cap → FR-013/FR-014 (gemini F3/F4, opencode F6/F11)
- [x] T010 split (T010a inject / T010b write-treatment) + `T009→T010a` edge (analyze F1/F2, opencode F3/F4)
- [x] "vetted"→"registered"; include/exclude exact-match; rescan-race + drift cache-invalidate (opencode F7/F10/F8/F9)

## Gate
- Specify + Clarify + Plan + Tasks + Analyze: **PASS** (analyze PASS, 3 MEDIUM advisories now remediated). 15 tasks.
- External review: opencode + gemini were **HIGH pre-remediation** → MUST **re-review** to reach ≥2 PASS (Principle VI) before `/speckit.implement`.
- Versioning (VII): branch `specs/014-per-assistant-mcp` exists; snapshot/commit deferred (no commit without consent).
