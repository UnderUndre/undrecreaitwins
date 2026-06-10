# SpecKit Analyze: 016-marketplace-comms

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-09T22:36:40+03:00
**Commit**: 9e30d79147fca33e4a843e450f2f0d322244c1df
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, research.md, contracts/, quickstart.md

> Первый прогон после full-plan 016 (clarified). Фокус: внутренняя консистентность + cross-spec риски.

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Constitution Alignment | MEDIUM | plan.md §Constitution Check («Compliance (новый инвариант) NON-NEGOTIABLE») | Plan заявляет новый NON-NEGOTIABLE инвариант, которого НЕТ в constitution v1.4.0. Per command: изменения принципов — отдельным constitution-апдейтом, не в plan. | Либо переформулировать как **feature-requirement** (FR-004/005, не «инвариант»), либо формально добавить принцип через `/speckit.constitution`. Не присваивать несуществующий принцип. |
| F2 | Inconsistency / Cross-spec | MEDIUM | tasks.md M004; spec.md FR-004 | M004 «extract policy-engine; валидаторы 004 зовут его» **модифицирует домен спеки 004** (`chat-service`), не принадлежащий 016. | Согласовать со спекой 004 (amendment/cross-ref). Зафиксировать как cross-spec зависимость; возможно — задача в 004. Plan уже помечает P0-M1 «координация» — поднять до явной зависимости. |
| F3 | Inconsistency / Cross-spec | MEDIUM | tasks.md M006; spec.md FR-005 | M006 модифицирует reengagement-runtime (009) + funnel (003) для channel-type gating — домены других спек. | Согласовать с 003/009 (их amendment или cross-spec задача). `isMarketplace()` predicate — общий, но OFF-точки живут в чужих спеках. |
| F4 | Inconsistency / Agent Routing | MEDIUM | tasks.md §Agent Summary + §Dispatch (M014) | M014 тегирован `[SEC] [US3]`, но учтён под `[E2E]` (dispatch-строка + count `[E2E]`=3). Двойной учёт → сумма агентов = 20 ≠ 19 задач. | Определить тег M014 (`[E2E]` ИЛИ `[SEC]`); `[E2E]`=2 (M010,M013); пересчитать summary до 19. |
| F5 | Coverage / Agent Routing | MEDIUM | tasks.md §Dependency Graph (M019) | M019 `[DOC]` отсутствует в графе зависимостей (нет ни одного ребра к нему), хотя Lane 8 и summary его держат. | Добавить ребро (напр. `M009 → M019` или `M010 → M019`) — DOC после первого канала, как M018. |
| B1 | Ambiguity | LOW | spec.md FR-002; tasks.md M008/M009/M012 | Фактический `inboundMode` (webhook vs poll) для Ozon/WB не зафиксирован — ждёт research-spike M008. | Приемлемо (gated M008→M009/M012). Зафиксировать per-площадка по итогам M008 до реализации адаптеров. |
| C1 | Coverage / Consistency | LOW | data-model.md (ChannelType += yandex); tasks.md M003/M015 | `yandex` добавлен в union на этапе M003, хотя Я.Маркет API не верифицирован (R7, Phase 2). | Добавлять `yandex` в union вместе с M015 (Phase 2), не раньше; иначе «мёртвый» тип. |
| U1 | Coverage | LOW | spec.md FR-007; tasks.md M009/M012 | FR-007 (идемпотентность) без отдельной задачи — растворён в адаптерах (webhook `seen:` SET NX, reuse 015). | Принять как adapter-level ИЛИ выделить явный under-test в M010/M013. |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| fr-001-marketplace-context | ✅ | M003 | |
| fr-002-adapter-webhook-or-poll | ✅ | M008,M009,M012 | mode pending M008 (B1) |
| fr-003-rest-send | ✅ | M009,M012 | |
| fr-004-shared-policy-engine | ✅ | M004 | cross-spec 004 (F2) |
| fr-005-compliance-gating | ✅ | M006 | cross-spec 003/009 (F3) |
| fr-006-rate-limit | ✅ | M012 | reuse 015 limiter |
| fr-007-idempotency | ⚠️ | M009,M012 | implicit (U1) |
| fr-008-kms-creds | ✅ | M007 | reuse 015 |
| fr-009-health | ✅ | M016 | |
| fr-010-order-context | ✅ | M011 | |
| nfr-compliance | ✅ | M005,M006,M014 | |
| nfr-isolation | ✅ | M017 | |
| nfr-rate-limit | ✅ | M012 | |

## Constitution Alignment Issues

- **F1** — plan присваивает несуществующий NON-NEGOTIABLE принцип «Compliance». Не конфликт с
  существующим MUST (поэтому не CRITICAL), но overreach: переформулировать как feature-req или
  провести через `/speckit.constitution`.
- **Principle IX** — артефакты в twin-engine; planning-ветка `016-…` не создана (plan помечает). Implement-этап.
- **Principle VII** — snapshot-теги отложены (грязное дерево/main) — задокументировано в plan.

## Unmapped Tasks

Нет полностью неотображённых. M008 (research-spike), M015 (Я.Маркет research+adapter), M018/M019
(ops/doc) — инфраструктурные/исследовательские, трассируются к FR-002/R7/деплою.

## Metrics

- Total Requirements: 14 (10 FR + 4 NFR)
- Total Tasks: 19 (M001–M019)
- Coverage % (requirements with ≥1 task): 100% (FR-007 ⚠️ implicit)
- Ambiguity count: 1 (B1)
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 5
- LOW count: 3

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: 2026-06-09T22:36:40+03:00
commit: 9e30d79147fca33e4a843e450f2f0d322244c1df
critical_count: 0
high_count: 0
medium_count: 5
low_count: 3
```

> PASS (0 CRITICAL, 0 HIGH). 5 MEDIUM — не блокеры гейта, но рекомендую закрыть до/во время
> внешнего ревью: F1 (wording/constitution), F2/F3 (cross-spec координация 004/003/009),
> F4/F5 (тривиальные правки tasks.md: счёт + orphan-граф). LOW — на усмотрение.
