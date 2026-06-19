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
- **Q: `version`/etag — integer counter или hash?** → A: **Integer counter** — выделенный `version` столбец в таблице `validator_configs` (не внутри JSONB). Инкрементируется на каждый PUT через атомарный `UPDATE ... WHERE version = $expected`. Product шлёт `expectedVersion` → Engine сравнивает через affected-rows → 409 CONFLICT на mismatch. Просто, без hash-вычислений, без TOCTOU.
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

- **AC**: `config.enabled === false` → pipeline не вызывает `LanguageGuardValidator.validate()`. No audit entries. System-prompt directive injection (`chat-service.ts`, `buildLanguageDirective`) также gated на `enabled !== false` — иначе disabled guard продолжит влиять на генерацию через директиву. Default: `true` (backward compat — старые configs без поля = enabled).

### US-4 — Audit log (P2)

`GET /v1/personas/:id/validators/language-guard/logs?limit=20&cursor=...` → пагинация на основе составного курсора (`cursor` — base64 от `createdAt_id` последнего элемента). Возвращает events из `validator_runs` где `validatorName: 'language-guard'`.

- **AC**: 200 с `{ items: ValidatorRun[], nextCursor: string|null }`. Каждый item: `{ id, verdict, metadata: { nonCompliantFraction, detectedScripts }, createdAt }`. 404 если persona не найдена.

### US-5 — Optimistic locking (P1)

`configVersion: number` in config response (read from dedicated `version` DB column). PUT принимает `expectedVersion`. Mismatch → 409 + current config в response (для diff на клиенте). Atomic — no TOCTOU between read and write.

- **AC**: GET возвращает `configVersion` (из столбца `version`). PUT без `expectedVersion` → 400 Bad Request. PUT с mismatched `expectedVersion` → 409 + `{ error: "CONFLICT", currentConfig: {...}, currentVersion: N }` (affected-rows = 0). PUT с matching → 200 + `configVersion` incremented (атомарный `UPDATE ... WHERE version = $expected`). First write → `INSERT ... ON CONFLICT DO UPDATE`.

## 4. Функциональные требования

- **FR-001**: `GET /v1/personas/:personaId/validators/language-guard` — возвращает `{ config: LanguageGuardConfig & { enabled, configVersion }, configVersion: number }`. Tenant scoped. Tenant ID резолвится существующим global `onRequest` hook в `server.ts` — приоритет: `x-tenant-claim` (base64url JSON `{tenant: <id>}`, credential-bound, выставляется Product BFF), fallback на `x-tenant-id` raw header. Несуществующий tenant → создастся (lazy), неактивный → `401 UnauthorizedError`.
- **FR-002**: `PUT /v1/personas/:personaId/validators/language-guard` — body `{ config: LanguageGuardConfig, expectedVersion: number }`. Сохраняет, инкрементирует `configVersion` (через atomic UPSERT). Tenant scoped тем же hook, что FR-001.
- **FR-003**: `enabled: boolean` добавляется в `LanguageGuardConfig` (`packages/core/src/types/validator.ts`). Default `true`. Pipeline: `if (config.enabled === false) return;` перед вызовом validator. Directive injection в `packages/core/src/services/chat-service.ts` (`buildLanguageDirective`) также gated: `if (cfg.enabled === false) return;` перед инъекцией директивы в system prompt.
- **FR-004**: `configVersion: number` — integer counter, хранится как выделенный столбец `version INTEGER` в таблице `validator_configs` (не внутри JSONB). GET возвращает. PUT строго требует `expectedVersion` (400 при отсутствии) и проверяет её через атомарный `UPDATE ... WHERE version = $expectedVersion` (affected-rows = 0 → 409). Первая запись использует `INSERT ... ON CONFLICT DO UPDATE` (UPSERT). 409 на mismatch.
- **FR-005**: Server-side validation on PUT: `stripThreshold <= blockThreshold` (400 if violated). `stripThreshold` и `blockThreshold` должны быть в диапазоне `[0, 1]` включительно (400 if violated — `THRESHOLD_RANGE`). `mode: 'active'` + empty `allowedLanguages` (400). `allowedLanguages` items must be valid BCP-47 codes (regex check, 400 on invalid). Дубликаты в `allowedLanguages` silently deduped перед сохранением. All validation errors on PUT return structured field-level errors: `{ error: "VALIDATION_FAILED", fields: { [fieldName]: string } }`.
- **FR-006**: `GET /v1/personas/:personaId/validators/language-guard/logs` — пагинация по составному курсору (`cursor`). Читает из `validator_runs` table (column projection: `id, verdict, confidence, matched_patterns, created_at` — excludes `original_content`, `remediated_content` for privacy), filtered by `validatorName: 'language-guard'`, ordered by `createdAt DESC, id DESC`. Query params: `limit` (default 20, max 100, `limit < 1` → 400), `cursor` (base64-строка `createdAt_id`, malformed → 400). Возвращает `metadata: { nonCompliantFraction, detectedScripts }` в структуре каждого лога.
- **FR-007**: Route registration — добавить validators route в `packages/api/src/routes/validators.ts` (NEW), зарегистрировать в `server.ts`.
- **FR-008**: RBAC — только tenant-scoped access. Engine резолвит tenant из `x-tenant-claim` (credential-bound, выставляется BFF) или `x-tenant-id` (fallback). Engine не знает roles; Product BFF enforces RBAC (owner/admin). Endpoints НЕ вводят собственный auth middleware — используют существующий global `onRequest` hook в `server.ts`.

## 5. Нефункциональные требования

- **NFR-1 (perf)**: GET config < 50ms, PUT < 100ms, audit log query < 200ms. Измерения — прямой DB round-trip на single-row lookup по PK `(tenant_id, persona_id, validator_name)` (напрямую через пул соединений). Кэш-слой в этой фиче НЕ вводится: конфиг-запросы низкочастотные (per-BFF), и отдельный кэш создал бы проблему инвалидации при PUT. Если load profile окажется выше ожидаемого — добавим cache отдельной фичей. Audit query использует существующий индекс `(validatorName, createdAt DESC, id DESC)`.
- **NFR-2 (backward compat)**: существующие configs без `enabled` → treated as `enabled: true`. Существующие configs без `version` column value (после миграции default 0) → `configVersion: 0`. PUT строго требует `expectedVersion` (даже для версии 0).
- **NFR-3 (изоляция)**: all queries scoped by `tenantId` резолвится из global `onRequest` hook в `server.ts` (приоритет `x-tenant-claim`, fallback `x-tenant-id`). Ни один endpoint не принимает tenant из другого источника.
- **NFR-4 (тест)**: unit tests for route handlers (GET/PUT/logs), config validation, version conflict, cross-tenant isolation (wrong tenant → reject), missing tenant context → 401.

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

- **LanguageGuardConfig** (extended): existing fields + `enabled: boolean`. `configVersion` — separate field in API response (`LanguageGuardConfigResponse.configVersion`), sourced from `version` DB column, not part of the JSONB config blob.
- **Validator config store**: existing per-(tenant, persona) storage for validator configs.
- **validator_runs** (existing table): audit log source. Language-guard writes `validatorName: 'language-guard'`, `verdict`, `confidence`→`nonCompliantFraction`, `matched_patterns`→`detectedScripts`.
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
- **SC-004**: `enabled: false` → pipeline skips language-guard (no audit entries, no validation) AND no system-prompt directive injection in `chat-service.ts`.
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
