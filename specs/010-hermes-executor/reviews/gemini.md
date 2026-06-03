# SpecKit Review: 010-hermes-executor

**Reviewer**: gemini
**Reviewed at**: 2026-06-03T02:15:00Z
**Commit**: e896ed6dccfdc8660932877f9c4a85c0ec72be98
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/hermes-executor.contract.md, research.md

## Summary

Архитектура Topology C (hybrid routing) является логичным развитием системы, превращающим twin из чат-бота в агента. Сильной стороной является "safety interlock" через `tool-gateway`, где Engine полностью контролирует доступ к внешнему миру и ключам. Главная слабость — стратегия `always-agent` (C2), которая может привести к неоправданному росту затрат на тривиальных запросах ("Привет", "Ок") и создает риск деградации UX из-за задержек multi-step циклов.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | UX / Logic | **Отсутствие протокола подтверждения (confirm flow).** Спецификация (C1, FR-007) требует подтверждения для high-stakes действий, но не описывает, как Engine должен прерывать стрим агента, запрашивать ввод пользователя и возобновлять цикл. В `tasks.md` (T015) нет задач на реализацию этого хэндшейка. | Описать в `contracts/` протокол прерывания агента (например, через специальный `StatusEvent: action_pending_approval`) и добавить задачу на реализацию асинхронного возобновления сессии после подтверждения. |
| F2 | HIGH | Reliability | **Отсутствие Engine-side таймаута для Hermes.** План (Reliability) говорит о fallback при недоступности, но не определяет жесткий таймаут на стороне Engine. Агентские циклы могут "зависать" или работать недопустимо долго. | Добавить в `hermes-executor.ts` (T005) конфигурацию `max_execution_time`. При превышении — принудительный обрыв связи и переход в fallback (thin completion). |
| F3 | MEDIUM | Cost / Perf | **Избыточность always-agent для тривиальных ходов.** Стратегия C2 (все, что не скрипт — в Hermes) заставляет запускать дорогой агентский цикл на фразы типа "Спасибо" или "Как дела?". Это 5-50x переплата за токены без пользы. | Внедрить в `turn-router.ts` (T008) легкий классификатор (cheap classifier) или проверку намерений, чтобы рулить тривиальные ходы в "thin completion" без привлечения Hermes. |
| F4 | MEDIUM | Consistency | **Амбивалентность scripted-ходов.** `spec.md` (US2) говорит, что в фуннелях Hermes может заполнять слоты, но `tasks.md` (T013) требует полной детерминированности. Неясно, используется ли в scripted-ходах агентский цикл или обычный completion. | Уточнить в `spec.md`, является ли Hermes в scripted-режиме "агентом с инструментами" или просто "мощной LLM для генерации текста". |
| F5 | MEDIUM | Performance | **Задержка гидратации Honcho.** При `spawn-on-demand` восстановление памяти из SoR может занимать значительное время, увеличивая TTFT (Time To First Token). | Добавить в `agent-lifecycle.ts` (T009) стратегию ленивой или фоновой гидратации, чтобы начинать стрим ответа до завершения полной реконструкции памяти, если это возможно. |

## Alternative approaches considered

- **Agent-if-needed (Topology B derivative)**: Вместо `always-agent`, использовать роутер, который вызывает Hermes только если запрос содержит намерение использовать инструмент (tool-use detection). Это безопаснее для бюджета, но сложнее в настройке для "проактивного" поведения. Текущий MIT-лицензионный `hermes-agent` позволяет это, если Engine будет первичным классификатором.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: gemini
reviewed_at: 2026-06-03T02:15:00Z
commit: e896ed6dccfdc8660932877f9c4a85c0ec72be98
critical_count: 0
high_count: 2
medium_count: 3
low_count: 0
```
