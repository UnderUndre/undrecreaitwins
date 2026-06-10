---
description: "Task list for 016 — Marketplace Customer-Comms (twin-engine)"
---

# Tasks: Marketplace Customer-Comms

**Input**: `/specs/016-marketplace-comms/` (spec, plan, research, data-model, contracts, quickstart)
**Target repo**: twin-engine `undrecreaitwins` (TS, pnpm, `@undrecreaitwins/*`)
**Depends on**: 015-foundation (T003–T006: ChannelType/ChannelMessage, creds-ciphertext, sole-gate).
**Tests**: compliance/isolation NFRs → `[SEC]` + `[E2E]` обязательны.

## ⚠️ Gate-0 (наследует 015 + новое)
- 015 P0-1/P0-2 (reengagement-валидаторы, creds-шифр) — общий хребет, должны быть закрыты.
- **P0-M1**: extract shared `policy-engine` (CL-016-3) — координация со спекой 004. Блокирует M005/M007.
- **P0-M2**: engine `isMarketplace()` + OFF-точки в 003/009 (FR-005). Блокирует M012.

## Format: `[ID] [AGENT] [Story?] Description`

## Phase 1: Setup
- [ ] M001 [SETUP] Scaffold `channel-<mp>` package template (зеркало `channel-telegram`) + `policy-engine` skeleton + `marketplace/` order-API dir
- [ ] M002 [SETUP] **Approval-gated (Standing Order 2)**: тонкие HTTP-клиенты Ozon/WB seller-API + order-API — подтвердить имена/версии перед install

## Phase 2: Foundational (Blocking)
- [ ] M003 [BE] `MarketplaceContext` тип + `ChannelType` += **ozon/wb (Phase 1)** + `ChannelMessage.marketplaceContext?` (`packages/shared/src/types.ts`), backward-compat с 015. **C1**: `yandex` добавляется с M015 (Phase 2, после верификации API) — не плодить «мёртвый» union-член заранее.
- [ ] M004 [BE] **(P0-M1)** Shared `core/services/policy-engine/` — **гибрид (glm-F2/FR-004a)**: regex prefilter → LLM-judge на `confidence < judgeThreshold` (`judgeModel` в `PolicyProfile`). `PolicyResult{allowed,violations,confidence,redactedText?}`. Валидаторы 004 (`chat-service`) зовут на marketplace-outbound **post-generation, любой источник** (FR-004b). + `MarketplaceRegistry.assertPolicyProfile()` fail-closed на boot (gemini-F1/FR-004c). Violation → block+regenerate (макс 2 → silent block), redact только явных contacts (FR-004d)
- [ ] M005 [SEC] **(P0-M1)** Per-marketplace `PolicyProfile` правила (off-platform redirect / контакты / ссылки) + семантические кейсы для judge (гомоглифы, «зелёный мессенджер», косвенный увод); нет профиля → канал не стартует. + `PolicyBlockEvent` audit-лог (glm-F8/FR-011): `{ts,tenantId,channelType,marketplace,convId,msgId,violations[],action}`, retention 90д, originalText encrypted
- [ ] M006 [BE] **(P0-M2)** `isMarketplace(channelType)` предикат + OFF-точки: reengagement(009) skip marketplace-conv; funnel(003) без redirect-стадий (FR-005)
- [ ] M007 [DB] Seller-API creds (Ozon `Client-Id`+`Api-Key`, WB token) через KMS (reuse 015 `credentialsCiphertext`+`kmsKeyRef`); per-(tenant,persona); review-only `.sql` если нужна колонка-делта
- [ ] M008 [BE] **Research-spike**: (a) верифицировать webhook у Ozon/WB (push vs поллинг) → `inboundMode` per-площадка (R4); (b) **chat-discovery (glm-F3/FR-002a)**: эндпоинты обнаружения новых чатов/вопросов (Ozon chat-list, WB Questions per `nmId`), стратегия watched-entities + round-robin + приоритизация под рейт-лимит

**Checkpoint**: модель+policy+gating+creds+transport-режим готовы.

## Phase 3: US1 — Ответ на вопрос по товару (P1) 🎯 MVP
**Independent Test**: вопрос на Ozon → INBOUND → RAG+гейт+policy → OUTBOUND → ответ; нет увода; tenant-scoped.
- [ ] M009 [BE] [US1] `channel-ozon` adapter (chat API `/v1/chat/start`,`/v1/chat/send/message`; `inboundMode` по M008; стампит `marketplaceContext`; 5 методов; типизир. ошибки)
- [ ] M010 [E2E] [US1] Ozon Q&A round-trip: гейт 004 + policy-engine отработали; off-platform-leak заблокирован; tenant-scoped; ack-after-send

**Checkpoint**: паттерн доказан на одной площадке через policy-гейт.

## Phase 4: US2 — Чат по заказу + order-context (P1)
**Independent Test**: WB buyer-chat → ответ с order-context; рейт-лимит соблюдён; деградация при недоступном order-API.
- [ ] M011 [BE] [US2] `core/services/marketplace/` order-API клиенты (Ozon posting / WB order) → `OrderContext` инжект как structured block в **system-prompt** (FR-010a; pull: order_chat всегда, question если sku-match); cache-key `cache:marketplace:order:<tenantId>:<postingId>` TTL 5/30мин (gemini-F5); degrade → system-нота «детали недоступны» НЕ галлюцинировать (FR-010b)
- [ ] M012 [BE] [US2] `channel-wb` adapter (buyer-chat + Questions/Reviews `nmId`; рейт-лимит 1 req/s backoff). **Per-seller-key (glm-F7)**: лимитер per-`(tenantId, marketplace, credsRef)`, НЕ per-channelType (несколько persona на одном WB-токене шарят лимит) — extension `channel-rate-limiter.ts`
- [ ] M013 [E2E] [US2] WB чат+вопрос round-trip; order-context инжектится; рейт-лимит держится (без блока); деградация order-API

## Phase 5: US3 — Compliance-guard (P1, NON-NEGOTIABLE)
- [ ] M014 [SEC] [US3] **(P0-M2)** Compliance E2E: funnel/reengagement OFF на marketplace-канале; увод с площадки → policy блок + audit; канал без policy-профиля НЕ стартует (fail-closed)

## Phase 6: Phase-2 площадка
- [ ] M015 [BE] **Research+adapter** `channel-yandexmarket` (после верификации seller chat API; R7)

## Phase 2.5: Review-remediation (gemini/glm — blocking implement)
- [ ] M020 [BE] **(DL-6/glm-F1 CRITICAL)** Cross-spec fallback: (a) policy-check **внутри marketplace-адаптера** pre-OUTBOUND, если 004 не интегрирует `policy-engine`; (b) `isMarketplace()`-гейт в `channel-orchestrator.ts` INBOUND-консьюмере — marketplace-канал не роутится в funnel(003)/reengagement(009), если их OFF-точки не приняты. Зафиксировать N-дневное окно (14) ожидания координации
- [ ] M021 [BE] **(glm-F4/FR-012)** Persist `marketplaceContext`: оркестратор сохраняет из INBOUND в Redis `mpctx:<conversationId>` (TTL) → достаёт при OUTBOUND publish (LLM-результат не несёт `chatId`/`questionId`). Без этого адаптер не знает куда слать

## Phase 7: Polish & Cross-Cutting
- [ ] M016 [BE] Per-channel `health()` + агрегат (reuse 015 FR-005); `degraded` при 429/рейт-лимит
- [ ] M017 [SEC] Tenant-isolation + creds-at-rest аудит (zero cross-tenant, no plaintext/log-leak)
- [ ] M018 [OPS] Per-marketplace consumer-process deploy + creds-provisioning runbook
- [ ] M019 [DOC] «Add a marketplace channel» + «authoring compliance PolicyProfile» doc

## Dependency Graph
### Dependencies
M001 → M003, M004, M009, M011, M012, M015
M002 → M009, M011, M012
M003 → M004, M009, M012
M004 → M005, M009, M012
M005 → M009, M012, M014
M006 → M014
M007 → M009, M012
M008 → M009, M012
M001 → M020, M021
M003 → M021
M020 → M009, M012
M021 → M009, M012
M009 → M010
M011 → M013
M012 → M013
M009 + M012 → M016, M017
M010 + M013 + M014 → M018
M009 → M019

### Self-Validation Checklist
- [x] Every task ID in Dependencies exists (M001–M021; M020 fallback / M021 mpctx-persist added 2026-06-09 review-remediation)
- [x] No circular dependencies
- [x] No orphan IDs
- [x] Fan-in uses `+`, fan-out uses `,`

## Parallel Lanes
| Lane | Agent Flow | Tasks | Blocked By |
|------|-----------|-------|------------|
| 1 | [SETUP] | M001, M002 | — |
| 2 | [BE] foundation | M003 → M004; M006; M008 | M001 |
| 3 | [SEC] policy/compliance | M005; M014; M017 | M004 / M006 / channels |
| 4 | [DB] creds | M007 | M001 + 015 creds |
| 5 | [BE] channels+order | M009; M011; M012; M015 | foundation (M003+M004+M005+M007+M008) |
| 6 | [E2E] | M010, M013, M014 | targets |
| 7 | [BE] polish | M016 | channels |
| 8 | [OPS]/[DOC] | M018, M019 | first channel |

## Agent Summary
| Agent | Task Count | Can Start After |
|-------|-----------|-----------------|
| [SETUP] | 2 | immediately |
| [BE] | 11 | M001 (+foundation) |
| [SEC] | 3 | M004/M006/channels |
| [DB] | 1 | M001 + 015 creds |
| [E2E] | 2 | targets (M010, M013) |
| [OPS] | 1 | first channel |
| [DOC] | 1 | first channel |

**Critical Path**: M001 → M003 → M004 → M005 → M009 → M010 → M018 (policy-engine + 015-foundation upstream)

## Agent Dispatch Plan
| Agent | Subagent | Skills | Input | Tasks | Files |
|-------|----------|--------|-------|-------|-------|
| `[SETUP]` | — | — | plan §structure | M001,M002 | `packages/channel-*/`, `core/services/policy-engine|marketplace/` |
| `[BE]` | `backend-specialist` | `api-patterns`,`system-design-patterns` | contracts, data-model, research | M003,M004,M006,M008,M009,M011,M012,M015,M016 | `packages/shared`, `core/services/*`, `packages/channel-ozon|wb` |
| `[SEC]` | `security-auditor` | `vulnerability-scanner`,`red-team-tactics` | spec §Compliance, contracts §policy | M005,M014,M017 | policy-engine, marketplace adapters, creds |
| `[DB]` | `database-architect` | `database-design` | data-model §creds | M007 | `core/models/channel-instances.ts`, migrations |
| `[E2E]` | `test-engineer` | `testing-patterns`,`webapp-testing` | quickstart, contracts | M010,M013 | `packages/channel-*/tests/integration/` (M014 compliance-E2E — под тегом [SEC]) |
| `[OPS]` | `devops-engineer` | `deployment-procedures` | plan §structure | M018 | deploy/process config, runbook |
| `[DOC]` | `documentation-writer` | `documentation-templates` | contracts | M019 | onboarding + policy-authoring doc |

## Implementation Strategy
- **Gate-0 first**: 015-foundation closed + extract policy-engine (M004) + compliance-gating (M006).
- **MVP**: Setup → foundation → **US1 Ozon (M009/M010)**. STOP & validate (quickstart S1). Один канал через policy-гейт доказывает паттерн.
- **Incremental**: US2 (order-context + WB) → US3 compliance E2E → Я.Маркет → polish.
- **Gated**: M002 (deps), Я.Маркет/webhook research (M008/M015), Principle IX ветка.
- **NON-NEGOTIABLE**: compliance (M005/M006/M014) — без этого канал не поднимается (бан-риск).
