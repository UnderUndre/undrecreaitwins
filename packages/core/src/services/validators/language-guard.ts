import {
  ResponseValidator,
  ValidatorContext,
  ValidatorRunResult,
  LanguageGuardConfig
} from '../../types/validator.js';
import { LLMClient } from '../llm-client.js';

const llm = new LLMClient();

type ScriptName = 'Common' | 'Latin' | 'Cyrillic' | 'Han' | 'Arabic' | 'Devanagari' | 'Hebrew' | 'Thai' | 'Hangul' | 'Katakana' | 'Hiragana' | 'Armenian' | 'Georgian' | 'Unknown';

interface ScriptRange {
  name: Exclude<ScriptName, 'Common' | 'Unknown'>;
  start: number;
  end: number;
}

const SCRIPT_RANGES: ScriptRange[] = [
  { name: 'Latin', start: 0x0041, end: 0x024F },
  { name: 'Latin', start: 0x1E00, end: 0x1EFF },
  { name: 'Cyrillic', start: 0x0400, end: 0x052F },
  { name: 'Han', start: 0x4E00, end: 0x9FFF },
  { name: 'Han', start: 0x3400, end: 0x4DBF },
  { name: 'Arabic', start: 0x0600, end: 0x06FF },
  { name: 'Devanagari', start: 0x0900, end: 0x097F },
  { name: 'Hebrew', start: 0x0590, end: 0x05FF },
  { name: 'Thai', start: 0x0E00, end: 0x0E7F },
  { name: 'Hangul', start: 0xAC00, end: 0xD7AF },
  { name: 'Hangul', start: 0x1100, end: 0x11FF },
  { name: 'Katakana', start: 0x30A0, end: 0x30FF },
  { name: 'Hiragana', start: 0x3040, end: 0x309F },
  { name: 'Armenian', start: 0x0530, end: 0x058F },
  { name: 'Georgian', start: 0x10A0, end: 0x10FF },
];

export const BCP47_TO_SCRIPTS: Record<string, string[]> = {
  ru: ['Cyrillic'],
  en: ['Latin'],
  zh: ['Han'],
  ar: ['Arabic'],
  hi: ['Devanagari'],
  he: ['Hebrew'],
  th: ['Thai'],
  ko: ['Hangul', 'Han', 'Latin'],
  ja: ['Hiragana', 'Katakana', 'Han', 'Latin'],
  kk: ['Cyrillic'],
  uk: ['Cyrillic'],
  uz: ['Latin'],
  ky: ['Cyrillic'],
  hy: ['Armenian'],
  ka: ['Georgian'],
  az: ['Latin'],
  be: ['Cyrillic'],
  tg: ['Cyrillic'],
  mo: ['Cyrillic'],
};

export const BCP47_TO_NAME: Record<string, string> = {
  ru: 'Russian', en: 'English', zh: 'Chinese', ar: 'Arabic',
  hi: 'Hindi', he: 'Hebrew', th: 'Thai', ko: 'Korean', ja: 'Japanese',
  kk: 'Kazakh', uk: 'Ukrainian', uz: 'Uzbek', ky: 'Kyrgyz',
  hy: 'Armenian', ka: 'Georgian', az: 'Azerbaijani', be: 'Belarusian',
  tg: 'Tajik', mo: 'Moldavian',
};

export const SCRIPT_TO_LANG: Record<string, string> = {
  Han: 'zh',
  Arabic: 'ar',
  Devanagari: 'hi',
  Hebrew: 'he',
  Thai: 'th',
  Armenian: 'hy',
  Georgian: 'ka',
  Hangul: 'ko',
  Katakana: 'ja',
  Hiragana: 'ja',
  Cyrillic: 'Cyrillic',
  Latin: 'Latin',
};

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const URL_RE = /https?:\/\/[^\s]+/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function isCommon(code: number): boolean {
  if (code <= 0x0020) return true;
  if (code >= 0x0030 && code <= 0x0039) return true;
  if (code >= 0x0021 && code <= 0x002F) return true;
  if (code >= 0x003A && code <= 0x0040) return true;
  if (code >= 0x005B && code <= 0x0060) return true;
  if (code >= 0x007B && code <= 0x007E) return true;
  if (code >= 0x00A0 && code <= 0x00BF) return true;
  if (code >= 0x2000 && code <= 0x206F) return true;
  if (code >= 0x2200 && code <= 0x22FF) return true;
  if (code >= 0x2E80 && code <= 0x2EFF) return true;
  if (code >= 0x3000 && code <= 0x303F) return true;
  if (code >= 0xFF00 && code <= 0xFFEF) return true;
  if (code >= 0x1F000 && code <= 0x1FAFF) return true;
  return false;
}

function isLetter(code: number): boolean {
  return /\p{L}/u.test(String.fromCodePoint(code));
}

class ScriptClassifier {
  static classify(code: number): ScriptName {
    if (isCommon(code)) return 'Common';

    for (const range of SCRIPT_RANGES) {
      if (code >= range.start && code <= range.end) {
        if (isLetter(code) || range.name !== 'Latin') {
          return range.name;
        }
      }
    }

    if (isLetter(code)) return 'Unknown';
    return 'Common';
  }

  static analyze(text: string): Map<ScriptName, number> {
    const counts = new Map<ScriptName, number>();
    for (const char of text) {
      const code = char.codePointAt(0)!;
      const script = this.classify(code);
      counts.set(script, (counts.get(script) || 0) + 1);
    }
    return counts;
  }
}

function maskCode(text: string): { masked: string; maskedCount: number } {
  let maskedCount = 0;
  const counters: Array<[RegExp, string]> = [
    [FENCED_CODE_RE, ''],
    [INLINE_CODE_RE, ''],
    [URL_RE, ''],
    [EMAIL_RE, ''],
  ];

  let masked = text;
  for (const [re] of counters) {
    masked = masked.replace(re, (match) => {
      maskedCount += match.length;
      return ' '.repeat(match.length);
    });
  }

  return { masked, maskedCount };
}



import { getLanguageGuardPrompt } from '../../locales/index.js';

function getEnvString(key: string, defaultValue: string): string {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return parsed;
}

const LANGID_MODEL = getEnvString('LANG_GUARD_LANGID_MODEL', 'gpt-4o-mini');
const LANGID_TIMEOUT_MS = getEnvNumber('LANG_GUARD_LANGID_TIMEOUT_MS', 3000);
const TRANSLATE_MODEL = getEnvString('LANG_GUARD_TRANSLATE_MODEL', 'gpt-4o-mini');
const TRANSLATE_TIMEOUT_MS = getEnvNumber('LANG_GUARD_TRANSLATE_TIMEOUT_MS', 3000);

function getLanguageNames(allowedLanguages: string[]): string {
  return allowedLanguages
    .map(l => BCP47_TO_NAME[l] || l)
    .join(', ');
}

export function buildLanguageDirective(target: string | string[], locale: 'en' | 'ru' = 'ru'): string {
  const template = getLanguageGuardPrompt('directiveTemplate', locale);
  const names = Array.isArray(target) ? getLanguageNames(target) : (BCP47_TO_NAME[target] || target);
  return template.replace('{languages}', names);
}

export function getFallbackMessage(allowedLanguages: string[], locale: 'en' | 'ru' = 'ru'): string {
  const template = getLanguageGuardPrompt('fallbackMessage', locale);
  return template.replace('{languages}', getLanguageNames(allowedLanguages));
}

export class LanguageGuardValidator implements ResponseValidator<LanguageGuardConfig> {
  name = 'language-guard';

  async validateAndMutate(
    reply: string,
    context: ValidatorContext<LanguageGuardConfig>
  ): Promise<ValidatorRunResult> {
    const startTime = Date.now();
    const { config } = context;

    if (!config.allowedLanguages || config.allowedLanguages.length === 0) {
      return {
        verdict: { decision: 'pass', confidence: 1.0 },
        mutatedText: reply,
        latencyMs: Date.now() - startTime,
      };
    }

    // 1. JSON Funnel envelope check (F14)
    let isFunnel = false;
    let funnelEnvelope: Record<string, unknown> | null = null;
    let replyToProcess = reply;

    if (reply.trim().startsWith('{') && reply.trim().endsWith('}')) {
      try {
        const parsed = JSON.parse(reply) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && 'answer' in parsed) {
          funnelEnvelope = parsed;
          isFunnel = true;
          replyToProcess = String(parsed.answer);
        } else {
          return {
            verdict: { decision: 'pass', confidence: 1.0 },
            mutatedText: reply,
            latencyMs: Date.now() - startTime,
          };
        }
      } catch (err) {
        return {
          verdict: {
            decision: 'pass',
            confidence: 1.0,
            matchedPatterns: [
              'remediation:skipped',
              'reason:funnel_malformed'
            ]
          },
          mutatedText: reply,
          latencyMs: Date.now() - startTime,
        };
      }
    }

    // 2. Resolve target language
    let targetResolution: TargetResolution;
    if (context.resolvedTargetLanguage) {
      targetResolution = { target: context.resolvedTargetLanguage, source: 'fixed' };
    } else {
      targetResolution = await resolveTargetLanguage(config, context.rawUserMessage, llm);
    }
    const targetLang = targetResolution.target;
    const targetScripts = new Set(BCP47_TO_SCRIPTS[targetLang] || ['Latin']);

    // 3. Outbound detection (script-based)
    const { masked } = maskCode(replyToProcess);
    const scriptCounts = ScriptClassifier.analyze(masked);

    const totalChars = [...replyToProcess].length;
    const commonChars = scriptCounts.get('Common') || 0;
    const scriptChars = totalChars - commonChars;

    if (scriptChars === 0) {
      return {
        verdict: { decision: 'pass', confidence: 1.0 },
        mutatedText: reply,
        latencyMs: Date.now() - startTime,
      };
    }

    let nonCompliantChars = 0;
    const detectedScripts: string[] = [];

    for (const [script, count] of scriptCounts) {
      if (script === 'Common' || script === 'Unknown') {
        if (script === 'Unknown') {
          nonCompliantChars += count;
          if (!detectedScripts.includes('Unknown')) detectedScripts.push('Unknown');
        }
        continue;
      }
      if (!targetScripts.has(script)) {
        nonCompliantChars += count;
        detectedScripts.push(script);
      }
    }

    const nonCompliantFraction = scriptChars > 0 ? nonCompliantChars / scriptChars : 0;
    const stripThreshold = config.stripThreshold ?? 0.05;

    let isViolation = nonCompliantFraction >= stripThreshold;
    let sourceLang = '';
    if (isViolation && detectedScripts[0]) {
      sourceLang = SCRIPT_TO_LANG[detectedScripts[0]] || detectedScripts[0];
    }

    // Same-script outbound check (FR-002b)
    if (!isViolation && (targetLang === 'en' || targetLang === 'ru') && config.allowPlatformModelRouting !== false) {
      if (isSameScriptViolationSuspected(replyToProcess, targetLang)) {
        let timer: NodeJS.Timeout | undefined;
        try {
          const langidModel = LANGID_MODEL;
          const timeoutMs = LANGID_TIMEOUT_MS;

          const systemPrompt = getLanguageGuardPrompt('langidSystemPrompt', 'ru')
            .replace(/{candidates}/g, config.allowedLanguages.join(', '));
          const llmPromise = llm.complete({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: replyToProcess }
            ],
            model: langidModel,
            temperature: 0,
            forcePlatformProvider: true,
          });

          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('outbound langid timeout')), timeoutMs);
          });

          const res = await Promise.race([llmPromise, timeoutPromise]);
          const content = res.content.trim();
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);

          const detectedOutboundLang = String(parsed.lang).trim().toLowerCase();
          if (detectedOutboundLang !== targetLang && (config.allowedLanguages || []).includes(detectedOutboundLang)) {
            isViolation = true;
            sourceLang = detectedOutboundLang;
          }
        } catch (err) {
          console.warn(`[language-guard] outbound langid failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }

    // Happy path
    if (!isViolation) {
      return {
        verdict: {
          decision: 'pass',
          confidence: 1.0 - nonCompliantFraction,
          matchedPatterns: [
            ...detectedScripts,
            'remediation:pass',
            `targetLang:${targetLang}`
          ]
        },
        mutatedText: reply,
        latencyMs: Date.now() - startTime,
      };
    }

    const runStripBlockFallback = (reason: string): ValidatorRunResult => {
      const blockThreshold = config.blockThreshold ?? 0.30;
    if (nonCompliantFraction >= blockThreshold) {
      const fallback = config.fallbackMessage?.trim() || getFallbackMessage(config.allowedLanguages);
        const finalReply = isFunnel
          ? JSON.stringify({ ...funnelEnvelope, answer: fallback })
          : fallback;
        return {
          verdict: {
            decision: 'block',
            confidence: nonCompliantFraction,
            reason: `non-compliant fraction ${nonCompliantFraction.toFixed(3)} >= blockThreshold ${blockThreshold}`,
            matchedPatterns: [
              ...detectedScripts,
              'remediation:blocked',
              `sourceLang:${sourceLang}`,
              `targetLang:${targetLang}`,
              `reason:${reason}`
            ],
          },
          mutatedText: finalReply,
          latencyMs: Date.now() - startTime,
        };
      } else {
        const strippedChars: string[] = [];
        for (const char of replyToProcess) {
          const code = char.codePointAt(0)!;
          const script = ScriptClassifier.classify(code);

          if (script === 'Common') {
            strippedChars.push(char);
            continue;
          }
          if (script === 'Unknown') {
            continue;
          }
          if (targetScripts.has(script)) {
            strippedChars.push(char);
          }
        }

        const strippedText = strippedChars.join('');
        const finalReply = isFunnel
          ? JSON.stringify({ ...funnelEnvelope, answer: strippedText })
          : strippedText;

        return {
          verdict: {
            decision: 'strip',
            confidence: nonCompliantFraction,
            reason: `non-compliant fraction ${nonCompliantFraction.toFixed(3)} >= stripThreshold ${stripThreshold}`,
            matchedPatterns: [
              ...detectedScripts,
              'remediation:stripped',
              `sourceLang:${sourceLang}`,
              `targetLang:${targetLang}`,
              `reason:${reason}`
            ],
          },
          mutatedText: finalReply,
          latencyMs: Date.now() - startTime,
        };
      }
    };

    const remediation = config.remediation || 'strip-block';

    if (remediation === 'translate' && !config.allowPlatformModelRouting) {
      console.warn('[language-guard] allowPlatformModelRouting is false. Falling back to strip-block.');
      return runStripBlockFallback('platform_routing_disallowed');
    }

    const timeElapsed = Date.now() - startTime;
    const projectedTime = timeElapsed + 3000;
    const AGENT_MAX_MS = getEnvNumber('AGENT_MAX_EXECUTION_MS', 20000);
    const CHANNEL_ACK_MS = getEnvNumber('TWIN_CHANNEL_ACK_TIMEOUT_MS', 15000);
    const executionLimit = Math.min(AGENT_MAX_MS, CHANNEL_ACK_MS);

    if (remediation === 'translate' && projectedTime > executionLimit) {
      console.warn('[language-guard] Latency budget exceeded. Falling back to strip-block.');
      return runStripBlockFallback('latency_budget_exceeded');
    }

    if (remediation === 'strip-block') {
      return runStripBlockFallback('config_strip_block');
    }

    let translateTimer: NodeJS.Timeout | undefined;
    try {
      const translateModel = TRANSLATE_MODEL;
      const translateTimeoutMs = TRANSLATE_TIMEOUT_MS;

      const { maskedText, tokens } = maskTokens(replyToProcess);

      const translateSystemPrompt = getLanguageGuardPrompt('translateSystemPrompt', 'ru')
        .replace('{target}', BCP47_TO_NAME[targetLang] || targetLang);

      const llmPromise = llm.complete({
        messages: [
          { role: 'system', content: translateSystemPrompt },
          { role: 'user', content: `<text_to_translate>\n${maskedText}\n</text_to_translate>` }
        ],
        model: translateModel,
        temperature: 0,
        forcePlatformProvider: true,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        translateTimer = setTimeout(() => reject(new Error('translate timeout')), translateTimeoutMs);
      });

      const res = await Promise.race([llmPromise, timeoutPromise]);
      const content = res.content.trim();
      const tagMatch = content.match(/<text_to_translate>([\s\S]*?)<\/text_to_translate>/i);
      const translatedMasked = tagMatch ? tagMatch[1].trim() : content.replace(/<\/?text_to_translate>/gi, '').trim();

      let fidelityOk = checkFidelity(translatedMasked, tokens);
      let translatedText = restoreTokens(translatedMasked, tokens);

      if (fidelityOk) {
        const originalNumbers = extractNumbers(replyToProcess);
        const translatedNumbers = extractNumbers(translatedText);
        const numbersMatch = compareArrays(originalNumbers, translatedNumbers, (x, y) => Math.abs(x - y) < 0.000001);

        const originalCurrencies = extractCurrencySymbols(replyToProcess);
        const translatedCurrencies = extractCurrencySymbols(translatedText);
        const currenciesMatch = compareArrays(originalCurrencies, translatedCurrencies);

        if (!numbersMatch || !currenciesMatch) {
          fidelityOk = false;
        }
      }

      if (fidelityOk) {
        const finalReply = isFunnel
          ? JSON.stringify({ ...funnelEnvelope, answer: translatedText })
          : translatedText;

        return {
          verdict: {
            decision: 'rewrite',
            confidence: 1.0,
            matchedPatterns: [
              ...detectedScripts,
              'remediation:translated',
              `sourceLang:${sourceLang}`,
              `targetLang:${targetLang}`,
              'fidelityOk:true'
            ]
          },
          mutatedText: finalReply,
          latencyMs: Date.now() - startTime,
        };
      }

      if (config.regenerateOnViolation !== false && context.regenerateFn && context.systemPrompt) {
        const reinforcedPrompt = `${context.systemPrompt}\nIMPORTANT: You must respond ONLY in ${BCP47_TO_NAME[targetLang] || targetLang}. The previous response was in the wrong language. Correct this and respond ONLY in ${BCP47_TO_NAME[targetLang] || targetLang}.`;
        const regeneratedText = await context.regenerateFn(reinforcedPrompt);

        let regenReplyToProcess = regeneratedText;
        let regenFunnelEnvelope: Record<string, unknown> | null = null;
        if (regeneratedText.trim().startsWith('{') && regeneratedText.trim().endsWith('}')) {
          try {
            regenFunnelEnvelope = JSON.parse(regeneratedText) as Record<string, unknown>;
            if (regenFunnelEnvelope && 'answer' in regenFunnelEnvelope) {
              regenReplyToProcess = String(regenFunnelEnvelope.answer);
            }
          } catch (e) {
            console.warn(`[language-guard] Failed to parse regenerated text as funnel envelope: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        const { masked: rMasked } = maskCode(regenReplyToProcess);
        const rScriptCounts = ScriptClassifier.analyze(rMasked);
        const rTotalChars = [...regenReplyToProcess].length;
        const rCommonChars = rScriptCounts.get('Common') || 0;
        const rScriptChars = rTotalChars - rCommonChars;

        let rNonCompliantChars = 0;
        for (const [script, count] of rScriptCounts) {
          if (script !== 'Common' && script !== 'Unknown' && !targetScripts.has(script)) {
            rNonCompliantChars += count;
          }
        }
        const rNonCompliantFraction = rScriptChars > 0 ? rNonCompliantChars / rScriptChars : 0;

        if (rNonCompliantFraction < stripThreshold) {
          return {
            verdict: {
              decision: 'rewrite',
              confidence: 1.0,
              matchedPatterns: [
                ...detectedScripts,
                'remediation:regenerated',
                `sourceLang:${sourceLang}`,
                `targetLang:${targetLang}`,
                'fidelityOk:false'
              ]
            },
            mutatedText: regeneratedText,
            latencyMs: Date.now() - startTime,
          };
        }
      }

      if (context.degradeToAsIs) {
        return {
          verdict: {
            decision: 'pass',
            confidence: 0,
            matchedPatterns: [
              ...detectedScripts,
              'remediation:degraded',
              `sourceLang:${sourceLang}`,
              `targetLang:${targetLang}`,
              'fidelityOk:false',
              'reason:translate_fidelity_fail'
            ]
          },
          mutatedText: reply,
          latencyMs: Date.now() - startTime,
        };
      }
      return runStripBlockFallback('translate_fidelity_fail');

    } catch (err) {
      console.warn(`[language-guard] translate failed: ${err instanceof Error ? err.message : String(err)}`);
      if (context.degradeToAsIs) {
        return {
          verdict: {
            decision: 'pass',
            confidence: 0,
            matchedPatterns: [
              ...detectedScripts,
              'remediation:degraded',
              `sourceLang:${sourceLang}`,
              `targetLang:${targetLang}`,
              'fidelityOk:false',
              'reason:translate_failed'
            ]
          },
          mutatedText: reply,
          latencyMs: Date.now() - startTime,
        };
      }
      return runStripBlockFallback('translate_failed');
    } finally {
      if (translateTimer) clearTimeout(translateTimer);
    }
  }
}

export interface TargetResolution {
  target: string;
  source: 'mirror' | 'fixed' | 'fallback' | 'degraded';
  langidConfidence?: number;
}

export async function resolveTargetLanguage(
  config: LanguageGuardConfig,
  userQuery: string | undefined,
  llmClient?: any
): Promise<TargetResolution> {
  const allowed = config.allowedLanguages || [];
  if (allowed.length === 0) {
    return { target: 'en', source: 'fallback' };
  }

  if (allowed.length === 1) {
    return { target: allowed[0] || 'en', source: 'fixed' };
  }

  const policy = config.targetPolicy || 'mirror';

  if (policy === 'fixed') {
    const fixed = config.fixedLanguage;
    if (fixed && allowed.includes(fixed)) {
      return { target: fixed, source: 'fixed' };
    }
    const fallback = config.fallbackLanguage || allowed[0] || 'en';
    return { target: fallback, source: 'fallback' };
  }

  if (!userQuery || !llmClient || config.allowPlatformModelRouting === false) {
    const fallback = config.fallbackLanguage || allowed[0] || 'en';
    return { target: fallback, source: 'fallback' };
  }

  try {
    const langidModel = LANGID_MODEL;
    const timeoutMs = LANGID_TIMEOUT_MS;

    const systemPrompt = `You are a language identification service. Identify the language of the user input.
You must respond with a JSON object containing:
- "lang": BCP-47 language code (must be one of: ${allowed.join(', ')})
- "confidence": confidence score between 0.0 and 1.0

Candidate languages: ${allowed.join(', ')}

JSON format:
{
  "lang": "code",
  "confidence": 0.95
}`;

    const llmPromise = llmClient.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery }
      ],
      model: langidModel,
      temperature: 0,
      forcePlatformProvider: true,
    });

    let langidTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      langidTimer = setTimeout(() => reject(new Error('langid timeout')), timeoutMs);
    });

    const res = await Promise.race([llmPromise, timeoutPromise]);
    
    const content = res.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    const detectedLang = String(parsed.lang).trim().toLowerCase();
    const confidence = Number(parsed.confidence);

    if (allowed.includes(detectedLang)) {
      const minConfidence = config.langidMinConfidence ?? 0.7;
      if (confidence >= minConfidence) {
        return {
          target: detectedLang,
          source: 'mirror',
          langidConfidence: confidence,
        };
      }
    }

    const fallback = config.fallbackLanguage || allowed[0] || 'en';
    return { target: fallback, source: 'fallback' };
  } catch (err) {
    console.warn(`[language-guard] langid failed or timed out: ${err instanceof Error ? err.message : String(err)}`);
    const fallback = config.fallbackLanguage || allowed[0] || 'en';
    return { target: fallback, source: 'degraded' };
  } finally {
    if (langidTimer) clearTimeout(langidTimer);
  }
}

const CYRILLIC_UNIQUE_CHARS: Record<string, RegExp> = {
  uk: /[єіїґЄІЇҐ]/u,
  be: /[ўіЎІ]/u,
  kk: /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u,
  tg: /[ғӣҳқҷӯҒӢҲҚҶӮ]/u,
  ky: /[өүңӨҮҢ]/u,
  mo: /[ӂӄӆӈӌҟ]/u,
};

const LATIN_STOP_WORDS: Record<string, string[]> = {
  de: ['der', 'die', 'das', 'ist', 'und', 'nicht', 'ich', 'wir', 'sie', 'es'],
  fr: ['le', 'la', 'les', 'est', 'et', 'dans', 'pour', 'avec', 'mais', 'nous'],
  es: ['el', 'la', 'los', 'las', 'es', 'y', 'en', 'para', 'con', 'pero'],
  uz: ['bir', 'bu', 'va', 'ning', 'bilan', 'uchun', 'ham', 'men', 'sen', 'u'],
  az: ['bir', 'bu', 'və', 'nin', 'ilə', 'üçün', 'həm', 'mən', 'sən', 'o'],
};

function isSameScriptViolationSuspected(text: string, targetLang: string): boolean {
  const normalized = text.toLowerCase();

  if (targetLang === 'ru') {
    for (const [lang, regex] of Object.entries(CYRILLIC_UNIQUE_CHARS)) {
      if (lang !== 'ru' && regex.test(text)) return true;
    }
  }

  if (targetLang === 'en') {
    const words = normalized.split(/[\s,.!?;:]+/).filter(Boolean);
    for (const [lang, stopWords] of Object.entries(LATIN_STOP_WORDS)) {
      if (lang !== 'en' && stopWords.some(sw => words.includes(sw))) {
        return true;
      }
    }
  }

  return false;
}

const DATE_RE = /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g;
const PRICE_RE = /(?:\b\d+[\d\s.,]*?\d+|\b\d+)\s*(?:USD|EUR|RUB|руб|рублей|[\$€₽])/gi;
const NUMBER_RE = /\b\d+(?:[.,]\d+)?\b/g;

function maskTokens(text: string): { maskedText: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  let counter = 0;
  let currentText = text;

  const replaceWithToken = (re: RegExp, prefix: string) => {
    currentText = currentText.replace(re, (match) => {
      const tokenId = `__${prefix}_${counter++}__`;
      tokens.set(tokenId, match);
      return tokenId;
    });
  };

  replaceWithToken(FENCED_CODE_RE, 'CODE');
  replaceWithToken(INLINE_CODE_RE, 'INLINE');
  replaceWithToken(URL_RE, 'URL');
  replaceWithToken(EMAIL_RE, 'EMAIL');
  replaceWithToken(PRICE_RE, 'PRICE');
  replaceWithToken(DATE_RE, 'DATE');
  replaceWithToken(NUMBER_RE, 'NUM');

  return { maskedText: currentText, tokens };
}

function restoreTokens(maskedText: string, tokens: Map<string, string>): string {
  let restored = maskedText;
  for (const [tokenId, originalValue] of tokens.entries()) {
    restored = restored.replace(tokenId, originalValue);
  }
  return restored;
}

function checkFidelity(translatedMasked: string, tokens: Map<string, string>): boolean {
  for (const tokenId of tokens.keys()) {
    if (!translatedMasked.includes(tokenId)) {
      return false;
    }
  }
  return true;
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  return matches.map(m => {
    let clean = m.replace(/[\s']/g, '');
    if (clean.includes(',') && clean.includes('.')) {
      if (clean.indexOf(',') < clean.indexOf('.')) {
        clean = clean.replace(/,/g, '');
      } else {
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
      }
    } else if (clean.includes(',')) {
      const parts = clean.split(',');
      if (parts.length === 2 && parts[1]?.length !== 3) {
        clean = clean.replace(/,/g, '.');
      } else {
        clean = clean.replace(/,/g, '');
      }
    }
    const val = parseFloat(clean);
    return isNaN(val) ? 0 : val;
  });
}

function compareArrays<T>(a: T[], b: T[], eqFn: (x: T, y: T) => boolean = (x, y) => x === y): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => eqFn(val, b[i] as T));
}

function extractCurrencySymbols(text: string): string[] {
  const currencyRegex = /\b(?:usd|eur|rub|рублей?)\b|[€$₽]/gi;
  const matches = text.match(currencyRegex) || [];
  return [...new Set(matches.map(m => m.toLowerCase()))];
}
