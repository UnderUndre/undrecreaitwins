# Feature Specification: Language Guard Validator Leftovers — API, Config Fields, Audit Log

**Feature Slug**: `023-language-guard-validator-leftovers`
**Repo**: `undrecreaitwins` (Engine)
**Created**: 2026-06-19
**Status**: CLARIFIED (session 2026-06-19)
**Input**: Code audit: `LanguageGuardValidator` (259 lines) is IMPLEMENTED and registered in pipeline, but 4 components are MISSING. Product spec `026-language-guard-config` depends on this spec.

## 1. Описание

`LanguageGuardValidator` полностью реализован как runtime-компонент (`packages/core/src/services/validators/language-guard.ts`, 259 строк, зарегистрирован в `pipeline.ts:15,24`). Но **внешний API для управления конфигурацией отсутствует** — нет HTTP-эндпоинтов для чтения/записи config, нет audit log API, нет полей `enabled` и `version` в config type.

Эта спека закрывает 4 пробела:
1. **HTTP API** для CRUD конфигурации language-guard (`GET/PUT /v1/personas/:id/validators/language-guard`)
2. **`enabled` поле** в `LanguageGuardConfig` — on/off toggle (требование Product 026 FR-014)
3. **`version`/etag** — optimistic locking (требование Product 026 FR-012)
4. **Audit log API** — endpoint для чтения history events (`GET /v1/personas/:id/validators/language-guard/logs`)

## Clarifications

### Session 2026-06-19

- **Q: Config storage — где хранится per-persona validator config?** → A: **Существующий validator config store** — Engine уже хранит per-(tenant, persona) validator конфиги (используется false-promise, format-injection, identity-guard). Language-guard config сохраняется туда же. Нужно добавить route для доступа.
- **Q: `enabled` = false → что делает pipeline?** → A: **Skip entirely** — pipeline проверяет `config.enabled !== false` перед вызовом validator. Если `enabled` отсутствует (старый config) → `true` (backward compat). Pipeline уже имеет skip-логику для empty `allowedLanguages` (`pipeline.ts:73-77`) — `enabled` — дополнительный gate.
- **Q: Audit log — отдельная таблица или существующая?** → A: **Существующая `validator_runs` таблица** — language-guard уже пишет туда results через pipeline. Нужен только read endpoint + query filter по `validatorName: 'language-guard'`.
- **Q: `version`/etag — integer counter или hash?** → A: **Integer counter** — `configVersion: number` в config, инкрементируется на каждый PUT. Product шлёт `If-Match: <version>` → Engine сравнивает → 409 CONFLICT на mismatch. Просто, без hash-вычислений.
- **Q: Optimistic locking bypass behavior in PUT requests** → A: `expectedVersion` является строго обязательным полем во всех `PUT` запросах (даже при первой настройке, где `expectedVersion` равен 0). Отсутствие `expectedVersion` возвращает ошибку `400 Bad Request`.
- **Q: Audit log cursor structure for pagination** → A: Используется составной курсор (**compound cursor**), состоящий из временной метки `createdAt` и идентификатора записи `id` (например, в формате base64-encoded `createdAt_id`). Это гарантирует абсолютную уникальность и детерминированность порядка вывода логов, исключая пропуски или дубли при совпадающих метках времени.
- **Q: Audit log JSON mapping in GET /logs** → A: **Nested metadata** — API возвращает `metadata: { nonCompliantFraction, detectedScripts }` вместо плоских полей. Это соответствует структуре таблицы `validator_runs` в БД, сохраняет расширяемость контракта и упрощает сериализацию.
- **Q: Validation error response format on PUT** → A: **Field-level validation** — при ошибках валидации (400 Bad Request) API возвращает структурированный JSON с деталями по каждому невалидному полю: `{ error: "VALIDATION_FAILED", fields: { [fieldName]: string } }`. Это позволяет Product UI точечно подсвечивать ошибки в интерфейсе.

## 2. Границы

**Это**: HTTP API endpoints (config CRUD + audit log), `enabled` + `configVersion` поля в LanguageGuardConfig type, route registration.

**Это НЕ**: Сам валидатор (уже реализован). Product UI (спека 026). Другие валидаторы.

## 3. Пользовательские истории

### US-1 — Читать конфигурацию language-guard (P1)

Внешний клиент (Product BFF) вызывает `GET /v1/personas/:id/validators/language-guard` → получает текущий `LanguageGuardConfig` + `configVersion`.

- **AC**: 200 с `{ config: LanguageGuardConfig, configVersion: number }`. 404 если persona не найдена. Config может быть пустым (default) → возвращает default config с `enabled: true`, `allowedLanguages: []`, `mode: 'dry-run'`.

### US-2 — Сохранять конфигурацию (P1)

`PUT /v1/personas/:id/validators/language-guard` с body `{ config: LanguageGuardConfig, expectedVersion: number }`. `expectedVersion` является строго обязательным (400 при отсутствии). Engine валидирует, сохраняет, инкрементирует `configVersion`.

- **AC**: 200 с обновлённым config + новый `configVersion`. 409 если `expectedVersion` не совпадает. 400 с `{ error: "VALIDATION_FAILED", fields: { [fieldName]: string } }` если `stripThreshold > blockThreshold` или `mode: 'active'` + `allowedLanguages` пустой.

### US-3 — Включать/выключать guard (P1)

`enabled: boolean` в config. `false` → pipeline skip (no directive injection, no validation, no audit). `true` → normal behavior.

- **AC**: `config.enabled === false` → pipeline не вызывает `LanguageGuardValidator.validate()`. No audit entries. Default: `true` (backward compat — старые configs без поля = enabled).

### US-4 — Audit log (P2)

`GET /v1/personas/:id/validators/language-guard/logs?limit=20&cursor=...` → пагинация на основе составного курсора (`cursor` — base64 от `createdAt_id` последнего элемента). Возвращает events из `validator_runs` где `validatorName: 'language-guard'`.

- **AC**: 200 с `{ items: ValidatorRun[], nextCursor: string|null }`. Каждый item: `{ id, verdict, metadata: { nonCompliantFraction, detectedScripts }, createdAt }`. 404 если persona не найдена.

### US-5 — Optimistic locking (P1)

`configVersion: number` in config response. PUT принимает `expectedVersion`. Mismatch → 409 + current config в response (для diff на клиенте).

- **AC**: GET возвращает `configVersion`. PUT без `expectedVersion` → 400 Bad Request. PUT с mismatched `expectedVersion` → 409 + `{ error: "CONFLICT", currentConfig: {...}, currentVersion: N }`. PUT с matching → 200 + `configVersion` incremented.

## 4. Функциональные требования

- **FR-001**: `GET /v1/personas/:personaId/validators/language-guard` — возвращает `{ config: LanguageGuardConfig & { enabled, configVersion }, configVersion: number }`. Tenant scoped via `X-Tenant-ID`.
- **FR-002**: `PUT /v1/personas/:personaId/validators/language-guard` — body `{ config: LanguageGuardConfig, expectedVersion: number }`. Сохраняет, инкрементирует `configVersion`.
- **FR-003**: `enabled: boolean` добавляется в `LanguageGuardConfig` (`packages/core/src/types/validator.ts`). Default `true`. Pipeline: `if (config.enabled === false) return;` перед вызовом validator.
- **FR-004**: `configVersion: number` — integer counter, хранится рядом с config. GET возвращает. PUT строго требует `expectedVersion` (400 при отсутствии) и проверяет её. 409 на mismatch.
- **FR-005**: Server-side validation on PUT: `stripThreshold <= blockThreshold` (400 if violated). `mode: 'active'` + empty `allowedLanguages` (400). `allowedLanguages` items must be valid BCP-47 codes (regex check, 400 on invalid). All validation errors on PUT return structured field-level errors: `{ error: "VALIDATION_FAILED", fields: { [fieldName]: string } }`.
- **FR-006**: `GET /v1/personas/:personaId/validators/language-guard/logs` — пагинация по составному курсору (`cursor`). Читает из `validator_runs` table, filtered by `validatorName: 'language-guard'`, ordered by `createdAt DESC, id DESC`. Query params: `limit` (default 20, max 100), `cursor` (base64-строка `createdAt_id`). Возвращает `metadata: { nonCompliantFraction, detectedScripts }` в структуре каждого лога.
- **FR-007**: Route registration — добавить validators route в `packages/api/src/routes/validators.ts` (NEW), зарегистрировать в `server.ts`.
- **FR-008**: RBAC — только tenant-scoped access (X-Tenant-ID header). Engine не знает roles; Product BFF enforces RBAC (owner/admin).

## 5. Нефункциональные требования

- **NFR-1 (perf)**: GET config < 50ms (cached in validator config store). PUT < 100ms. Audit log query < 200ms (indexed on `validatorName, createdAt DESC, id DESC`).
- **NFR-2 (backward compat)**: существующие configs без `enabled`/`configVersion` → treated as `enabled: true`, `configVersion: 0`. PUT строго требует `expectedVersion` (даже для версии 0).
- **NFR-3 (изоляция)**: all queries scoped by `tenantId` from `X-Tenant-ID` header (existing Engine pattern).
- **NFR-4 (тест)**: unit tests for route handlers (GET/PUT/logs), config validation, version conflict.

## 6. Краевые случаи

- Persona без language-guard config (never configured) → GET returns default config (`enabled: true, allowedLanguages: [], mode: 'dry-run', stripThreshold: 0.05, blockThreshold: 0.30, regenerateOnViolation: false`), `configVersion: 0`.
- PUT с `expectedVersion: 0` на never-configured persona → creates config, version becomes 1.
- `enabled: false` + `mode: 'active'` → valid (enabled=false overrides mode; pipeline skips entirely).
- Audit log для never-active guard → empty list, no error.
- Concurrent PUT (two requests, same expectedVersion) → first 200, second 409.
- Invalid BCP-47 code (`allowedLanguages: ["xx-yy"]`) → 400 with specific error message `{ error: "VALIDATION_FAILED", fields: { allowedLanguages: "Invalid BCP-47 language code: xx-yy" } }`.
- `configVersion` overflow (extremely unlikely) → wraps via `BigInt` or hard cap at `Number.MAX_SAFE_INTEGER`.
- **Overlapping log timestamps**: два лога имеют одинаковый `createdAt` → детерминировано сортируются по `id DESC`. Курсор `createdAt_id` предотвращает дублирование при пагинации.

## 7. Ключевые сущности

- **LanguageGuardConfig** (extended): existing fields + `enabled: boolean` + `configVersion: number`.
- **Validator config store**: existing per-(tenant, persona) storage for validator configs.
- **validator_runs** (existing table): audit log source. Language-guard writes `validatorName: 'language-guard'`, `verdict`, `metadata: { nonCompliantFraction, detectedScripts }`.
- **Validators route** (NEW): `packages/api/src/routes/validators.ts` — HTTP endpoints for validator config CRUD + logs.

## 8. Зависимости

- **LanguageGuardValidator** (IMPLEMENTED): `packages/core/src/services/validators/language-guard.ts`. Runtime работает. Эта спека только добавляет API layer.
- **ValidatorPipeline** (IMPLEMENTED): `pipeline.ts` — registered, default mode `dry-run`. Skip logic for empty `allowedLanguages` exists (`pipeline.ts:73-77`).
- **validator_runs table** (IMPLEMENTED): existing audit table, already written to by pipeline.
- **Product spec 026**: `ai-twins/specs/026-language-guard-config` — UI consuming this API. Blocked-by: this spec.

## 9. Success Criteria

- **SC-001**: `GET /v1/personas/:id/validators/language-guard` returns config with `enabled` and `configVersion`.
- **SC-002**: `PUT` with valid config → 200, `configVersion` incremented.
- **SC-003**: `PUT` with mismatched `expectedVersion` → 409 + current config.
- **SC-004**: `enabled: false` → pipeline skips language-guard (no audit entries, no validation).
- **SC-005**: `GET /logs` returns language-guard events with verdict + fraction + scripts.
- **SC-006**: Existing configs (without `enabled`/`configVersion`) → backward compatible (treated as `enabled: true, version: 0`).

## 10. Out of Scope

- Product UI (spec 026).
- LanguageGuardValidator runtime changes (already implemented).
- Other validators (false-promise, format-injection, identity-guard).
- WebSocket for real-time audit (Product 026 uses polling).

## 11. Глоссарий

- **LanguageGuardConfig** — per-persona configuration: `allowedLanguages`, `stripThreshold`, `blockThreshold`, `fallbackMessage`, `regenerateOnViolation`, `mode`, `enabled`, `configVersion`.
- **configVersion** — integer counter for optimistic locking. Incremented on each PUT.
- **enabled** — boolean toggle. `false` = pipeline skips validator entirely (no directive, no validation, no audit).
