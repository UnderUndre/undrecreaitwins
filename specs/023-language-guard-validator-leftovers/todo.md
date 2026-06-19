```
# ЗАДАЧА: Доделать code review findings D-5 — D-13 для фичи 023 (language-guard-validator-leftovers)

## Контекст проекта

Репо: `undrecreaitwins` — multi-tenant AI-twin engine.
Stack: TypeScript 5.x, Node 20, pnpm workspace. Fastify 5.x, Drizzle ORM + PostgreSQL, Vitest.
Фича: `specs/023-language-guard-validator-leftovers/` — HTTP config CRUD + audit-log endpoint для language-guard валидатора.

Ключевые файлы:
- `packages/api/src/routes/validators.ts` — 3 endpoint'а (GET/PUT config, GET logs)
- `packages/core/src/services/validators/pipeline.ts` — ValidatorPipeline (skip при enabled:false)
- `packages/core/src/services/validators/language-guard.ts` — сам валидатор
- `packages/core/src/services/chat-service.ts` — directive injection в buildSystemPrompt()
- `packages/core/src/types/validator.ts` — типы (LanguageGuardConfig + enabled)
- `packages/api/tests/integration/validators.test.ts` — интеграционные тесты endpoint'ов
- `packages/core/src/test/validators/pipeline-enabled.test.ts` — тест pipeline skip
- `packages/core/src/test/validators/directive-gate.test.ts` — тест directive skip
- `specs/023-language-guard-validator-leftovers/contracts/PUT-config.md` — контракт PUT
- `specs/023-language-guard-validator-leftovers/data-model.md` — модель данных

## УНИВЕРСАЛЬНЫЕ ПРАВИЛА (соблюдать ВСЕ)

1. ALL DB queries inside `withTenantContext(tenantId, fn)`.
2. Cross-package imports: `@undrecreaitwins/core/...` (НЕ относительные пути).
3. No `as any` — используй proper types или `unknown`.
4. No `console.log()` — `console.warn`/`console.error` with structured context.
5. No `catch (e) {}` — логируй и rethrow или return safe default.
6. Migrations — review-only `.sql` файлы, НЕ выполнять.
7. После каждого изменения: `pnpm --filter @undrecreaitwins/core exec tsc --noEmit` + `pnpm --filter @undrecreaitwins/api run build`.
8. Тесты: `pnpm --filter @undrecreaitwins/core exec vitest run src/test/validators/` + `pnpm --filter @undrecreaitwins/api exec vitest run tests/`.
9. Читай файл ПЕРЕД редактированием. Следуй существующим паттернам кода.
10. Спавни сабагентов для параллельной работы над независимыми задачами.

## ЗАДАЧИ

### D-5 (HIGH): Расширить directive-gate.test.ts

**Проблема**: `directive-gate.test.ts` существует, но T012 требует также протестировать что `enabled: false` в конфиге language-guard **пропускает (skip)** directive injection в `chat-service.ts` `buildSystemPrompt()`. Текущий тест может не покрывать это полностью.

**Что сделать**:
1. Прочитай `packages/core/src/test/validators/directive-gate.test.ts` (текущее состояние).
2. Прочитай `packages/core/src/services/chat-service.ts` строки ~1020-1040 (directive injection logic — гейт на `cfg?.enabled !== false`).
3. Прочитай `specs/023-language-guard-validator-leftovers/tasks.md` T012 acceptance criteria.
4. Убедись что тест покрывает:
   - `enabled: false` + non-empty `allowedLanguages` → directive строка ("IMPORTANT: You must respond ONLY in") **ОТСУТСТВУЕТ** в промпте
   - `enabled: true` + non-empty `allowedLanguages` → directive **ПРИСУТСТВУЕТ**
   - `enabled` отсутствует (undefined) + non-empty `allowedLanguages` → directive **ПРИСУТСТВУЕТ** (backward compat, `!== false`)
   - Пустые `allowedLanguages` → directive **ОТСУТСТВУЕТ** (FR-012 no-op)
5. Если тест уже покрывает эти сценарии — ничего не делай, отметь как done.
6. Если не покрывает — добавь недостающие test cases.

**Verify**: `pnpm --filter @undrecreaitwins/core exec vitest run src/test/validators/directive-gate.test.ts` — все тесты pass.

---

### D-6 (HIGH): Рефактор хрупких mock'ов в validators.test.ts

**Проблема**: `packages/api/tests/integration/validators.test.ts` использует `createChainableMock()` который возвращает разные данные в зависимости от `withTenantContextCallCount` (порядковый номер вызова). Тесты зависят от порядка вызовов, а не от поведения. Любое добавление нового DB-запроса сломает все тесты.

**Что сделать**:
1. Прочитай `packages/api/tests/integration/validators.test.ts` полностью.
2. Замени order-dependent mock pattern на **behavior-dependent**:
   - Вместо "if callCount === 1 return X" → "if query targets table personas return X, if validatorConfigs return Y"
   - Или: используй `vi.mock()` для модуля `@undrecreaitwins/core/db.js` с детектированием запроса по SQL/table name
   - Или: использи Map-based mock где ключ — это table name или SQL pattern
3. Добавь недостающие сценарии из T011 (currently покрыто 5 из 13):
   - GET с существующим конфигом (non-default path) — returns saved config + configVersion > 0
   - PUT create success (first-write, expectedVersion: 0 → 200 + configVersion: 1)
   - PUT update success (existing version: 1, expectedVersion: 1 → 200 + configVersion: 2)
   - PUT version conflict (expectedVersion: 99 → 409 + currentConfig в response)
   - Cross-tenant isolation (tenantId A не видит config tenantId B)
   - GET /logs с непустым результатом + pagination (nextCursor round-trip)
   - GET /logs пустой результат → `{ items: [], nextCursor: null }`
   - Persona не найдена → 404
4. Каждый тест должен быть **независимым** — setup/teardown между тестами, общее состояние запрещено.

**Verify**: `pnpm --filter @undrecreaitwins/api exec vitest run tests/integration/validators.test.ts` — все тесты pass. Запусти 3 раза подряд — не должно быть flaky.

---

### D-8 (MEDIUM): configVersion overflow protection

**Проблема**: `specs/023-language-guard-validator-leftovers/data-model.md` §6 говорит: "hard cap at Number.MAX_SAFE_INTEGER — further PUTs return 409". Реализация в `validators.ts` делает `version + 1` без проверки переполнения.

**Что сделать**:
1. Прочитай `packages/api/src/routes/validators.ts` — найди блок UPDATE (после `existing.version !== expectedVersion` check, перед `version: existing.version + 1`).
2. Добавь проверку:
```typescript
if (existing.version >= Number.MAX_SAFE_INTEGER) {
  return reply.status(409).send({
    error: 'VERSION_OVERFLOW',
    message: 'configVersion has reached maximum. Contact administrator to reset.',
    currentVersion: existing.version,
  });
}
```

1. Это должно быть ДО `tx.update()` вызова, внутри `withTenantContext` (т.к. `existing` загружен через SELECT FOR UPDATE).

**Verify**: `pnpm --filter @undrecreaitwins/api run build` — tsc clean.

---

### D-9 (MEDIUM): Унификация error codes в контракте

**Проблема**: `data-model.md` §5 и `PUT-config.md` §Validation Rules указывают коды `THRESHOLD_ORDER`, `THRESHOLD_RANGE`, `INVALID_BCP47`, `EMPTY_ACTIVE_LANGUAGES`. Реализация в `validators.ts` возвращает `{ error: "VALIDATION_FAILED", fields: { [fieldName]: "message" } }` — machine-readable коды не включены в response. Контракт неоднозначен: codes в таблице vs пример response без codes.

**Что сделать**:

1. Прочитай `specs/023-language-guard-validator-leftovers/contracts/PUT-config.md` (error section ~line 55-75).
2. Прочитай `specs/023-language-guard-validator-leftovers/data-model.md` §5 (validation table).
3. **Решение**: расширить `VALIDATION_FAILED` response — добавить коды в fields:

```typescript
// Вместо:
validationErrors.stripThreshold = 'stripThreshold must be <= blockThreshold';
// Сделать:
validationErrors.stripThreshold = 'THRESHOLD_ORDER: stripThreshold must be <= blockThreshold';
```

Или лучше — структурированный формат:

```typescript
return reply.status(400).send({
  error: 'VALIDATION_FAILED',
  fields: {
    stripThreshold: { code: 'THRESHOLD_ORDER', message: 'stripThreshold must be <= blockThreshold' },
    allowedLanguages: { code: 'INVALID_BCP47', message: 'Invalid BCP-47: xx-yy' },
  },
});
```

1. Обнови контракт `PUT-config.md` чтобы пример response соответствовал коду.
2. Обнови тесты в `validators.test.ts` чтобы проверяли codes.

**Verify**: `pnpm --filter @undrecreaitwins/api run build` + тесты pass.

---

### D-10 (LOW): Исправить пути тестов в tasks.md

**Проблема**: T011 указывает `packages/api/tests/unit/routes/validators.test.ts`, реальный файл — `packages/api/tests/integration/validators.test.ts`. T012 указывает `packages/core/tests/integration/pipeline.test.ts`, реальный — `packages/core/src/test/validators/pipeline-enabled.test.ts`.

**Что сделать**:

1. Прочитай `specs/023-language-guard-validator-leftovers/tasks.md`.
2. Найди T011 и T012 описания.
3. Обнови пути файлов на реальные:
   - T011: `packages/api/tests/integration/validators.test.ts`
   - T012: `packages/core/src/test/validators/pipeline-enabled.test.ts` + `packages/core/src/test/validators/directive-gate.test.ts`

---

### D-11 (LOW): Унифицировать detectedScripts тип (string[] vs objects)

**Проблема**: `data-model.md` §3 говорит что `matched_patterns → detectedScripts` это "JSONB array of `{ language, confidence }` objects". Контракт `GET-logs.md` пример показывает `"detectedScripts": ["Cyrillic"]` (строки). Реализация в `validators.ts` кастит `r.matchedPatterns as string[]`. Спека внутренне противоречива.

**Что сделать**:

1. Прочитай `specs/023-language-guard-validator-leftovers/data-model.md` §3.
2. Реальность: language-guard.ts хранит `detectedScripts` как `string[]` (имена скриптов: "Han", "Cyrillic") в `Verdict.matchedPatterns`. В DB `matched_patterns` это JSONB → попадает как `string[]`.
3. Обнови `data-model.md` §3: замени "JSONB array of `{ language, confidence }` objects" на "JSONB array of script name strings (e.g. `['Han', 'Cyrillic']`)". Это соответствует контракту и реализации.

---

### D-12 (LOW): Документировать INVALID_CURSOR error code

**Проблема**: `validators.ts` возвращает `{ error: 'INVALID_CURSOR', message: 'Malformed cursor' }` при невалидном cursor. Контракт `GET-logs.md` говорит "Malformed/invalid cursor → 400" без указания code.

**Что сделать**:

1. Прочитай `specs/023-language-guard-validator-leftovers/contracts/GET-logs.md` (error section).
2. Добавь: "Malformed cursor → `400 { error: 'INVALID_CURSOR', message: 'Malformed cursor' }`"

---

### D-13 (LOW): Документировать currentConfig: null при first-write race

**Проблема**: При extremely narrow race condition (concurrent INSERT между verify и write), 409 response возвращает `currentConfig: null`. Контракт не определяет этот shape.

**Что сделать**:

1. Прочитай `specs/023-language-guard-validator-leftovers/contracts/PUT-config.md` (409 section).
2. Добавь note: "In rare concurrent-insert race conditions, `currentConfig` may be `null`. Client should retry the PUT with `expectedVersion: 0`."

---

## ПОРЯДОК ВЫПОЛНЕНИЯ

1. **D-5** и **D-10** можно делать параллельно (независимые — тест vs spec doc). Спавни 2 сабагента.
2. **D-6** — отдельно (крупный рефактор тестов, 1 сабагент).
3. **D-8** — отдельно (код фикс, 1 сабагент).
4. **D-9** — отдельно (код + контракт + тесты, 1 сабагент).
5. **D-11, D-12, D-13** — параллельно (doc-only, 3 сабагента или 1 на все три).

После всех задач:

```bash
pnpm --filter @undrecreaitwins/core exec tsc --noEmit
pnpm --filter @undrecreaitwins/api run build
pnpm --filter @undrecreaitwins/core exec vitest run src/test/validators/
pnpm --filter @undrecreaitwins/api exec vitest run tests/integration/validators.test.ts
```

Все 4 команды должны пройти без ошибок.

## ФИНАЛЬНЫЙ ОТЧЁТ

Для каждой задачи (D-5 — D-13) сообщи:

- Статус: FIXED / SKIPPED (с причиной)
- Изменённые файлы (paths)
- Верификация: pass/fail

```
