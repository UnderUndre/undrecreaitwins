# Prompt: Fix code review findings for 024-language-guard-rewrite-mirror

## Repo
`C:/Users/Admin/Documents/Repos/underhelpers/under-ai-helpers/undrecreaitwins`
Branch: `024-language-guard-rewrite-mirror`

## Context
Code review identified 3 HIGH bugs + 11 MEDIUM/LOW quality issues + 8 missing test scenarios. This prompt covers ALL remaining work. Fix in priority order: R1 → R2 → R3 → tests → quality.

## Constraints
- **Read spec first**: `specs/024-language-guard-rewrite-mirror/spec.md` (FR-001..013, NFR-1..5, §6 edge cases)
- **Read plan**: `specs/024-language-guard-rewrite-mirror/plan.md` (contracts, data-model, config validation rules)
- **Verify after each fix**: `cd packages/core && npm run validate && npm run test:unit`
- **No new deps without confirmation**
- **No `as any`, no `console.log/warn`**, no empty catch, no `process.env.X || "fallback"`
- Use repo logger (consola pattern) for all logging
- Structural error classification (`err.code`, `instanceof`, `err.name` — not `err.message.includes()`)

---

## Phase 1: HIGH bugs (block merge)

### R1: NFR-4 — langid bypasses `allowPlatformModelRouting` gate

**File**: `packages/core/src/services/validators/language-guard.ts`
**Lines**: ~289-306 (outbound langid), ~588-620 (resolveTargetLanguage inbound langid)

**Bug**: `allowPlatformModelRouting` is checked before translate (~line 395-397) but NOT before langid calls. Both inbound mirror langid and outbound same-script langid use `forcePlatformProvider: true` unconditionally. A BYOK tenant with `allowPlatformModelRouting: false` + `targetPolicy: 'mirror'` still sends user text to platform model.

**Fix**: Add the same gate before EVERY `llm.complete({ forcePlatformProvider: true })` call:
- **Inbound langid** (`resolveTargetLanguage`): if `config.allowPlatformModelRouting === false` → skip langid entirely → degrade to `fixedLanguage` or `fallbackLanguage` (source: `'degraded'`).
- **Outbound same-script langid** (~line 289-306): if `config.allowPlatformModelRouting === false` → skip langid → use script-only detection result (less precise, but no platform routing).

**Test**: add test case `allowPlatformModelRouting: false` + mirror config → assert langid NOT called, target = fallback, audit source = 'degraded'.

### R2: strip fallback uses wrong script set

**File**: `packages/core/src/services/validators/language-guard.ts`
**Line**: ~347 (`runStripBlockFallback` strip branch)

**Bug**: strip uses `getAllowedScripts(config.allowedLanguages)` — ALL allowed languages' scripts. If `allowed=['ru','en']`, `target='en'`, answer in German (Latin script) → strip keeps German text because `'Latin' ∈ getAllowedScripts(['ru','en'])`. Spec intent: strip to TARGET language only.

**Fix**: Use `targetScripts` (already computed at ~line 224) instead of `getAllowedScripts(config.allowedLanguages)`. The `block` branch already targets correctly — strip must match.

**Test**: `allowed=['ru','en']`, `target='en'`, answer with German Latin text → strip removes non-target-script chars.

### R3: translate prompt injection — weak content fencing

**File**: `packages/core/src/services/validators/language-guard.ts`
**Lines**: ~425-428 (translate prompt construction)

**Bug**: Translate prompt uses `[Text to translate]\n${maskedText}` with no closing fence. A malicious answer containing `[Text to translate]` can manipulate the translator. Spec F9 requires content **fenced**.

**Fix**: Use XML-style fencing for user/answer content in the translate prompt:
```
Translate the following text to {targetName}. Preserve ALL placeholders (__NUM0__, __PRICE1__, etc.) exactly as-is.

<text_to_translate>
{maskedText}
</text_to_translate>

Do not add, remove, or translate content inside placeholders. Output only the translated text.
```

**Test**: answer containing `[Text to translate]` injection → translate still works correctly, injection ignored.

---

## Phase 2: Missing tests (8 scenarios)

**File**: `packages/core/src/test/validators/language-guard.test.ts`

Add tests for (follow existing test patterns in the file):

1. **US-2 mirror langid**: multi-language config (`allowed=['ru','en']`, `targetPolicy='mirror'`), mock langid returning `'en'` with confidence 0.9 → assert target resolved to `'en'`, directive built correctly.

2. **US-3 disallowed inbound**: langid returns `'fr'` (∉ allowed) → assert target falls back to `fallbackLanguage`.

3. **US-3 low-confidence**: langid returns confidence 0.3 (< `langidMinConfidence` 0.7) → assert target falls back to `fallbackLanguage`.

4. **FR-002b same-script detect**: `allowed=['en']`, answer in German (both Latin) → script detector flags same-script suspicion → outbound langid called → violation detected → translate fires.

5. **FR-011 config validation** (in `packages/api/src/test/` or equivalent):
   - `fallbackLanguage` not in `allowedLanguages` → 400.
   - `targetPolicy='fixed'` without `fixedLanguage` → 400.
   - `allowed.length==1` + `targetPolicy='mirror'` → ignored, pin.
   - Invalid BCP-47 code → 400.

6. **FR-013 agentic path**: mock agentic answer with off-target language → assert remediation runs, answer translated/degraded.

7. **F14 funnel malformed**: answer is invalid JSON funnel envelope → assert detection skipped, remediation skipped, audit `remediation: 'skipped'` + reason `funnel_malformed`.

8. **NFR-2 latency budget**: mock `Date.now()` to simulate elapsed time exceeding budget → assert regenerate skipped, strip/block fires directly.

---

## Phase 3: Quality fixes (R4-R14)

### R4: `as any` guardrail violations
**Files**: `language-guard.ts:191,468`; `chat-service.ts:332,349,807,824`; `funnel-runtime.ts:267,672,808`

Replace:
- `let funnelEnvelope: any = null` → define `interface FunnelEnvelope { answer: string; stage_transition?: unknown; slots?: unknown }` or use `unknown` + type narrowing.
- `const cfg = langConfig.config as any` → use the actual `LanguageGuardConfig` type (import from `types/validator.ts`).
- `.map((r: any) => ...)` → type the array elements properly.
- `let langGuardSpy: any` (test) → type as `jest.SpyInstance` or `Mock`.

### R5: `console.warn` → structured logger
**Files**: `language-guard.ts:306,397,409,555,669`; `chat-service.ts:382,862,1235`

Replace every `console.warn(...)` / `console.error(...)` with the repo's logger pattern:
```typescript
import logger from '<repo logger import path>';
logger.warn({ err, context: 'language-guard' }, 'message');
```
Check existing files for the logger import path (consola-based).

### R6: Latency budget incomplete
**File**: `language-guard.ts:402-411`

Current: `projectedTime = timeElapsed + 3000` (only translate).
Fix: project full worst-case before deciding regenerate:
```typescript
const REGEN_ESTIMATE_MS = 5000; // env or config
const projectedTotal = timeElapsed + REGEN_ESTIMATE_MS;
if (projectedTotal > budgetLimit) {
  // skip regenerate, go to strip/block
}
```

### R7: Config validation F13-d missing
**File**: `packages/api/src/routes/validators.ts`

Add: if `targetPolicy === 'mirror' && fixedLanguage` → strip `fixedLanguage` from config, return warning in response (or audit).

### R8: setTimeout resource leak
**File**: `language-guard.ts:298,440,611` (and resolveTargetLanguage timeout)

Pattern found:
```typescript
const result = await Promise.race([
  llm.complete(...),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
]);
```
Fix: store timer ref, clear on completion:
```typescript
let timer: NodeJS.Timeout;
try {
  const result = await Promise.race([
    llm.complete(...),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 3000);
    })
  ]);
  return result;
} finally {
  if (timer) clearTimeout(timer);
}
```
Or use `AbortSignal.timeout(3000)` if Node version supports it.

### R9: Duplicate agentic remediation code
**File**: `chat-service.ts:327-385` and `:801-859`

~58 lines duplicated between non-streaming and streaming agentic paths.
Extract to private method:
```typescript
private async runAgenticLanguageGuard(
  agentResult: AgentResult,
  request: ChatRequest,
  persona: Persona,
  conversationId: string
): Promise<{ answer: string; remediationResult: RemediationResult }>
```

### R10: Audit sourceLang empty for script-detected violations
**File**: `language-guard.ts:263,339,369,433,541,568`

When violation detected by script-only (no langid outbound), `sourceLang` stays `''`.
Fix: set `sourceLang` from detected scripts. Either:
- Map script → representative BCP-47 (e.g., `'Cyrillic' → 'ru'`), or
- Record the script name itself (e.g., `sourceLang: 'Latin-script'`).

### R11: extractCurrencySymbols substring match
**File**: `language-guard.ts:636-637`

Replace `.includes('usd')` with word-boundary regex:
```typescript
const CURRENCY_RE = /\b(?:USD|EUR|RUB|₽|\$|€|£|¥|KZT|UAH|UZS|...)\b/i;
```

### R12: Module-level LLMClient singleton
**File**: `language-guard.ts:13`

`const llm = new LLMClient()` at module scope. Acceptable for now if tests work, but note for future DI refactor. **Skip unless trivial.**

### R13: Fragile JSON extraction from langid
**File**: `language-guard.ts:296`

Replace:
```typescript
content.replace(/^```json\s*/, '').replace(/```$/, '')
```
With:
```typescript
const jsonMatch = content.match(/\{[\s\S]*\}/);
const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
```

### R14: Empty catch on regenerate funnel parse
**File**: `language-guard.ts:451`

Replace `catch {}` with:
```typescript
catch (e) {
  logger.debug({ err: e }, 'regenerate output is not a funnel envelope, treating as plain text');
}
```

---

## Phase 4: FR-002b expansion (optional, if time permits)

**File**: `language-guard.ts:287`

Outbound same-script detection currently hardcoded for `en`/`ru` targets. Other Latin-script pairs (e.g., `uz` → `az`, both Latin) not covered.
Fix: generalize the same-script check to compare `BCP47_TO_SCRIPTS[target]` vs detected response scripts dynamically.

---

## Verification

After ALL fixes:
```bash
cd packages/core && npm run validate && npm run test:unit && npm run test:integration
cd packages/api && npm run validate && npm test
```

All tests must pass. No new `as any`, `console.log/warn`, empty catch, or `process.env.X || "fallback"` in changed code.

## Commit

One commit per phase (or one per fix if small). Follow repo commit convention:
```
fix(language-guard): enforce allowPlatformModelRouting gate on langid calls (R1)
fix(language-guard): strip fallback targets resolved language scripts only (R2)
fix(language-guard): fence translate prompt content against injection (R3)
test(language-guard): add mirror, same-script, config, agentic, funnel, latency tests
refactor(language-guard): replace as any, console.warn, fix setTimeout leak, extract agentic method
```
