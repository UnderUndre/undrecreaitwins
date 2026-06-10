# Implementation Plan: Marketplace Customer-Comms

**Branch**: `016-marketplace-comms` | **Date**: 2026-06-09 | **Spec**: [spec.md](spec.md)
**Input**: `/specs/016-marketplace-comms/spec.md` (clarified 2026-06-09)

## ⚠️ Cross-repo / branch note
Target = twin-engine (`undrecreaitwins`, TS, pnpm, `@undrecreaitwins/*`). Артефакты здесь же
(`undrecreaitwins/specs/016-…`). Principle IX: завести `016-marketplace-comms` planning-ветку до
`/speckit.implement` (сейчас `main`; plan прогнан через `SPECIFY_FEATURE`). **016 НЕ имплементится
раньше 015-foundation** (T003–T006) — общий хребет.

## Summary
Дать твину отвечать покупателям на маркетплейсах (Ozon, WB; Я.Маркет — Phase 2): вопросы по товару,
отзывы, чат по заказу. **Полный твин, policy-gated** (CL-016-1): персона+RAG, но funnel(003)+
reengagement(009) принудительно OFF, и shared `policy-engine` (CL-016-3) режет увод с площадки.
Переиспользует 015-хребет (`ChannelAdapter`, Redis-стримы, валидаторы 004, KMS-креды, rate-limiter,
webhook-signature). Новое: `MarketplaceContext`, `policy-engine`-модуль, order-API клиенты,
compliance-gating по `channel_type`, transport webhook-or-poll (CL-016-2).

## Gate-0 Prerequisites (наследует 015)
- Те же P0-1 (reengagement→валидаторы) / P0-2 (creds ciphertext) из 015 — общий код. 016 поверх
  закрытого гейта.
- **NEW P0-M1**: extract `policy-engine` из/рядом с валидаторами 004 (CL-016-3) — координация со спекой 004.
- **NEW P0-M2**: engine-предикат `isMarketplace(channelType)` + точки выключения в 003/009 (FR-005).
- **NEW P0-M3 (cross-spec fallback — glm-F1/DL-6)**: каждая зависимость от 003/004/009 имеет план-Б
  (policy внутри адаптера; `isMarketplace()`-гейт в orchestrator INBOUND) + N-дневное окно. 016 НЕ
  зависает, если владелец чужой спеки откажет.

## Technical Context
**Lang**: TS 5.x / Node 20 (pnpm monorepo). **Deps (approval-gated, Standing Order 2)**: тонкие
HTTP-клиенты Ozon Seller API (`Client-Id`+`Api-Key`) / WB (`buyer-chat-api` + Feedbacks) / order-API;
reuse `KmsProvider`, `channel-rate-limiter`, `webhook-signature` из 015. **Storage**: Postgres
(`channel_instances` reuse), Redis (streams + dedup + order-context cache). **Testing**: vitest
(unit+integration), compliance E2E. **Constraints**: per-tenant isolation; рейт-лимиты площадок
(WB 1 req/s); compliance fail-closed; деградация order-API.

## Constitution Check
| Принцип | Статус |
| --- | --- |
| **VI** Cross-AI Review Gate | ⏳ после tasks (analyze + ≥2 external) |
| **VII** Artifact Versioning | ⏳ snapshot plan/tasks (отложено: грязное дерево/main) |
| **IX** Two-Phase branch | 🟡 артефакты в twin-engine; завести `016-…` ветку до implement |
| Governance §4 (complexity) | ✅ reuse 015-контракт+оркестратор; новые пакеты = паттерн telegram; policy-engine оправдан (shared, CL-016-3) |
| **DD-HX-001 / sole gate** | ✅ marketplace outbound идёт через 004 + policy-engine (усиление гейта, не обход) |
| **Compliance (feature-requirement, NOT constitution-принцип)** | 🟡 funnel/reengO OFF + policy fail-closed — заложено FR-004/005, верифицируется E2E (M014). ⚠️ **analyze-F1**: это feature-уровневый инвариант, НЕ принцип constitution v1.4.0. Если нужен governance-уровень — провести через `/speckit.constitution` отдельно, не присваивать в plan. |

**Gate verdict: PASS с флагами** — gate-0 (015 + policy-engine extraction) + ветка IX + dep approvals + Я.Маркет/webhook research.

## Project Structure (twin-engine paths)
```text
packages/shared/src/types.ts        # +MarketplaceContext, +ozon/wb/yandex в ChannelType
packages/core/src/services/
├── policy-engine/                   # НОВЫЙ (CL-016-3): PolicyProfile/PolicyResult; зовут 004 + каналы
├── channel-orchestrator.ts          # reuse; isMarketplace() predicate; marketplaceContext routing
├── chat-service.ts                  # валидаторы 004 → policy-engine.check() для marketplace
├── marketplace/                     # НОВЫЙ: order-API клиенты (ozon-order.ts, wb-order.ts) + cache
└── llm-provider/crypto.ts           # reuse KMS для seller-creds
packages/core/src/services/reengagement/  # FR-005: skip marketplace conversations
packages/core/src/services/funnel/        # FR-005: no redirect-stages on marketplace
packages/channel-ozon/               # НОВЫЙ — chat API (/v1/chat/*); inboundMode webhook|poll
packages/channel-wb/                 # НОВЫЙ — buyer-chat + Questions/Reviews; rate-limit 1/s
packages/channel-yandexmarket/       # Phase 2 — после верификации API
# каждый: src/index.ts (process+creds), src/<mp>-adapter.ts (5 методов + marketplaceContext), tests/integration/
```
**Structure Decision**: один пакет на площадку (зеркалит `channel-telegram`); shared policy-engine +
order-API в `core`. Inbound-режим объявляется адаптером (webhook|poll, CL-016-2).

## Complexity Tracking
| Violation | Why Needed | Rejected Alternative |
| --- | --- | --- |
| `policy-engine` новый модуль | shared между 004 и 016 (CL-016-3) | дубль в 016 = расхождение; только в 004 = не переиспользуемо |
| order-API клиенты per-mp | контекст заказа в RAG (CL-016-4) | text-only = хуже продуктово |
| compliance-gating в 003/009 | детерминированный OFF (бан-риск) | надежда на промпт = недетерминированно |
| hybrid policy (regex+LLM-judge) | regex не ловит семантику (бан-риск, glm-F2) | regex-only = дырявое; judge-only = +latency/cost на 100% |
| chat-discovery (watched-entities) | поллинг без discovery не находит новые чаты (glm-F3) | опрос всех SKU = 16 мин/цикл на WB |
| marketplaceContext persist (mpctx) | LLM-результат не несёт chatId (glm-F4) | без персиста адаптер не знает куда слать |

## Phase 0 — Research
[research.md](research.md): reuse-foundation, compliance-gating, policy-engine, transport (webhook TODO), message model, order-context, Я.Маркет deferred.

## Phase 1 — Design & Contracts
- [data-model.md](data-model.md) — MarketplaceContext, policy-engine, order-context, gating.
- [contracts/](contracts/) — marketplace adapter + policy-engine + order-API контракты.
- [quickstart.md](quickstart.md) — Q&A через гейт+policy, чат заказа с order-context, compliance-guard.
- [architecture.md](../main/architecture.md) — добавить marketplace-comms домен + policy-engine (при планировании).

**Post-Design re-check**: PASS с флагами (gate-0, ветка IX, dep approvals, webhook/Я.Маркет research).
