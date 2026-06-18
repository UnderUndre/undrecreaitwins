# Task Prompt: Externalize LLM Prompts + Language Guard UI Spec

Два задания для другого AI. Каждое самостоятельное.

---

## Задание 1: Externalize LLM Prompts (Engine — `undrecreaitwins`)

**Репо**: `C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins`

### Проблема

4 файла содержат inline-промпты (русский, захардкожен в TypeScript):

1. `packages/core/src/services/llm/adaptive-intro.ts` — systemPrompt (генерация мостика-интро)
2. `packages/core/src/services/llm/slot-extractor.ts` — systemPrompt (извлечение слотов) + userPrompt template
3. `packages/core/src/services/llm/intent-classifier.ts` — system content (классификация намерений)
4. `packages/core/src/services/llm/contextual-reteller.ts` — systemPrompt (контекстуальный пересказ)

Плюс:
5. `packages/core/src/services/llm/guards/banned-words.ts` — хардкоженные русские banned words
6. `packages/core/src/services/llm/guards/output-guard.ts` — хардкоженный repair-prompt

### Задача

Создать `packages/core/src/prompts/` со структурой:

```
packages/core/src/prompts/
├── index.ts              # Resolver: getPrompt(key, locale?) → PromptTemplate
├── types.ts              # PromptTemplate interface
├── ru/
│   ├── adaptive-intro.json
│   ├── slot-extraction.json
│   ├── intent-classifier.json
│   ├── contextual-retell.json
│   ├── banned-words.json
│   └── repair-prompts.json
└── en/
    ├── adaptive-intro.json
    ├── slot-extraction.json
    ├── intent-classifier.json
    ├── contextual-retell.json
    ├── banned-words.json
    └── repair-prompts.json
```

### Спецификация файлов

**types.ts:**
```typescript
export interface PromptTemplate {
  system: string;           // System prompt text (may contain {{placeholders}})
  userTemplate?: string;    // User message template (optional, may contain {{placeholders}})
  variables?: string[];     // List of expected placeholder names
}

export type PromptKey =
  | 'adaptive-intro'
  | 'slot-extraction'
  | 'intent-classifier'
  | 'contextual-retell'
  | 'banned-words'
  | 'repair-prompts';

export type Locale = 'ru' | 'en';
```

**index.ts (resolver):**
```typescript
import type { PromptTemplate, PromptKey, Locale } from './types.js';
import * as ru from './ru/index.js';
import * as en from './en/index.js';

const locales: Record<Locale, Record<PromptKey, PromptTemplate>> = {
  ru: ru.default,
  en: en.default,
};

const DEFAULT_LOCALE: Locale = 'ru';

export function getPrompt(key: PromptKey, locale?: Locale): PromptTemplate {
  const resolvedLocale = locale ?? DEFAULT_LOCALE;
  const localePack = locales[resolvedLocale] ?? locales[DEFAULT_LOCALE];
  return localePack[key] ?? locales[DEFAULT_LOCALE][key];
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}
```

**ru/adaptive-intro.json:**
```json
{
  "system": "Ты — помощник, который пишет очень короткие (1 предложение) переходные фразы в диалоге.\nТвоя задача: связать последнее сообщение пользователя с целью следующего этапа разговора.\n\nПРАВИЛА:\n1. Пиши максимально разговорно и естественно.\n2. Используй разговорные частицы: ну, же, ведь, короче, слушай.\n3. Используй нижний регистр для коротких фраз, если это уместно.\n4. Можешь опускать подлежащее (например, \"Пойду уточню\" вместо \"Я пойду уточню\").\n5. Используй инверсию порядка слов для смыслового акцента.\n6. Длина: максимум 100 символов.\n7. Только одно предложение.\n8. Не используй кавычки в ответе.\n\nЦель фрагмента: {{fragmentObjective}}",
  "userTemplate": "Сообщение пользователя: \"{{userMessage}}\"\nНапиши короткую переходную фразу-мостик:",
  "variables": ["fragmentObjective", "userMessage"]
}
```

**ru/slot-extraction.json:**
```json
{
  "system": "Ты — сервис извлечения структурированных данных из диалога.\n\nЗадача: проанализируй диалог и извлеки значения слотов.\n\nОПРЕДЕЛЕНИЯ СЛОТОВ:\n{{slotDescriptions}}\n\nСУЩЕСТВУЮЩИЕ СЛОТЫ (уже извлечённые):\n{{existingSlotsJson}}\n\nПРАВИЛА:\n1. Возвращай ТОЛЬКО JSON объект с ключами = имена слотов, значения = извлечённые данные.\n2. Если значение не найдено в диалоге — не включай ключ в ответ.\n3. Для слотов с enum — используй ТОЛЬКО допустимые значения. Если значение не совпадает ни с одним из enum — не включай ключ.\n4. Confidence: общая оценка достоверности извлечения (0.0 - 1.0).\n5. Если слот уже существует в conversationSlots — НЕ перезаписывай его.\n\nФормат ответа:\n{\n  \"extracted\": { \"имя_слота\": \"значение\" },\n  \"confidence\": 0.85\n}",
  "userTemplate": "Диалог:\nПользователь: \"{{userMessage}}\"\nАссистент: \"{{assistantReply}}\"\n\nИзвлеки слоты из этого диалога:",
  "variables": ["slotDescriptions", "existingSlotsJson", "userMessage", "assistantReply"]
}
```

**ru/intent-classifier.json:**
```json
{
  "system": "Ты — бинарный классификатор намерений. Определи, является ли сообщение пользователя утвердительным (согласие, подтверждение, согласие). Ответь ТОЛЬКО \"yes\" или \"no\".",
  "variables": []
}
```

**ru/contextual-retell.json:**
```json
{
  "system": "Ты — редактор диалоговых фраз. Переформулируй предложенный фрагмент, сохраняя смысл, но меняя формулировку.\n\nПРАВИЛА:\n1. Не повторяй дословно — перефразируй.\n2. Сохраняй тон и стиль персоны.\n3. Учитывай контекст диалога ниже.\n4. Длина ответа — близка к оригиналу (±30%).\n5. Не добавляй информацию, которой нет в оригинале.\n6. Только переформулированный текст, без кавычек и комментариев.",
  "userTemplate": "Контекст диалога:\n{{historyBlock}}\n\nИсходный фрагмент: «{{fragmentContent}}»\n\nПереформулируй фрагмент с учётом контекста:",
  "variables": ["historyBlock", "fragmentContent"]
}
```

**ru/banned-words.json:**
```json
{
  "hard": ["как искусственный интеллект", "я языковая модель", "как AI", "я не могу", "я всего лишь"],
  "soft": ["в качестве", "следует отметить", "инновационный", "потенциал", "давайте рассмотрим", "важно понимать"]
}
```

**ru/repair-prompts.json:**
```json
{
  "bannedWords": "Избегай фраз: {{bannedPhrases}}. Переформулируй.",
  "antiRepeat": "Не повторяй предыдущий ответ. Переформулируй."
}
```

**en/ файлы** — те же ключи, английский текст. Пример en/adaptive-intro.json:
```json
{
  "system": "You are an assistant writing very short (1 sentence) transitional phrases for a conversation.\nYour task: connect the user's last message with the goal of the next conversation stage.\n\nRULES:\n1. Write as naturally and conversationally as possible.\n2. Use casual fillers: well, so, I mean, look, listen.\n3. Use lowercase for short phrases where appropriate.\n4. You may drop the subject (e.g., \"Gonna check\" instead of \"I'm gonna check\").\n5. Max 100 characters.\n6. Only one sentence.\n7. No quotes in the response.\n\nFragment objective: {{fragmentObjective}}",
  "userTemplate": "User message: \"{{userMessage}}\"\nWrite a short bridge phrase:",
  "variables": ["fragmentObjective", "userMessage"]
}
```

### Рефакторинг исходных файлов

Каждый из 4 LLM-сервисов должен:
1. Импортировать `getPrompt`, `interpolate` из `../../prompts/index.js`
2. Принимать `locale?: Locale` в конструкторе или параметрах
3. Заменить inline systemPrompt на `getPrompt('xxx', locale)`
4. Заменить inline userPrompt на `interpolate(template.userTemplate, vars)`
5. Для slot-extractor: `slotDescriptions` и `existingSlotsJson` подставляются через `interpolate`
6. Для banned-words: конфиг из JSON (с возможностью override из funnel config)
7. Для output-guard repair-prompt: из `getPrompt('repair-prompts')`

### Порядок работы

1. Создать `packages/core/src/prompts/types.ts`
2. Создать `packages/core/src/prompts/index.ts`
3. Создать `packages/core/src/prompts/ru/` (6 файлов)
4. Создать `packages/core/src/prompts/en/` (6 файлов)
5. Рефакторить `adaptive-intro.ts` → использовать resolver
6. Рефакторить `slot-extractor.ts`
7. Рефакторить `intent-classifier.ts`
8. Рефакторить `contextual-reteller.ts`
9. Рефакторить `banned-words.ts` → default config из JSON
10. Рефакторить `output-guard.ts` → repair-prompt из JSON
11. Прогнать существующие тесты (все должны пройти — тексты те же)

### Acceptance

- 0 inline-промптов в .ts файлах (grep = 0)
- `getPrompt('adaptive-intro', 'ru')` возвращает тот же текст что был в коде
- `getPrompt('adaptive-intro', 'en')` возвращает английскую версию
- `interpolate("Hello {{name}}", { name: "World" })` → "Hello World"
- Все существующие unit-тесты проходят

---

## Задание 2: Language Guard UI Spec (Product — `ai-twins`)

**Репо**: `C:\Users\Admin\Documents\Repos\ai-twins`

### Промт для написания спеки

```
Ты — архитектор B2B SaaS платформы AI-Twins. Твоя задача — написать feature specification для UI настройки Language Guard (валидатор языка ответов) в репозитории ai-twins (Product layer).

КОНТЕКСТ:
- Engine (undrecreaitwins) уже имеет Language Guard validator (spec 017-language-guard-validator).
- Engine API: per-persona validator config через `PUT /v1/personas/:id/validators/:name` с `{ config: LanguageGuardConfig }`.
- LanguageGuardConfig = { mode: 'active'|'dry-run', allowedLanguages: string[], stripThreshold: number (0-1, default 0.05), blockThreshold: number (0-1, default 0.30), fallbackMessage?: string, regenerateOnViolation: boolean (default false) }
- Спека 017 явно говорит: "Product config UI is out of scope for this spec" — значит UI ещё не сделан.
- Существующий паттерн UI для валидаторов: apps/web/src/pages/account/[workspaceSlug]/assistants/[id]/index.js → вкладка "Валидаторы" (ValidatorsSettingsForm).

ЧТО НУЖНО:

Напиши spec.md в specs/026-language-guard-config/ со следующей структурой:

1. Описание: UI для настройки Language Guard на странице ассистента.
2. User Stories:
   - US-1: Включить language guard (выбрать allowedLanguages из списка BCP-47 кодов: ru, en, kk, zh, ar, etc.)
   - US-2: Настроить режим (active / dry-run)
   - US-3: Настроить пороги (stripThreshold, blockThreshold — слайдеры 0-100%)
   - US-4: Указать fallback message (textarea)
   - US-5: Включить regenerateOnViolation (checkbox)
   - US-6: Видеть audit log (последние N language guard events — verdict, fraction, detectedScripts)
3. Functional Requirements: FR-001..010
4. Non-Functional: perf (<50ms load), i18n (react-i18next), RBAC (owner/admin)
5. Edge Cases: empty allowedLanguages = disabled; stripThreshold > blockThreshold = validation error; dry-run mode badge
6. Dependencies: Engine 017 (validator config API), existing ValidatorsSettingsForm pattern
7. Success Criteria: operator can configure language guard without API calls; thresholds validated before save

ТЕХНИЧЕСКИЙ СТЕК:
- Next.js (Pages Router), React 18, Tailwind
- react-i18next (NOT next-intl)
- Существующая вкладка "Валидаторы" — расширь, не создавай новую страницу
- API: apps/web BFF route → Engine PUT /v1/personas/:id/validators/language-guard

ВЫДАЙ: полный spec.md файл, готовый для /speckit.clarify.
```
