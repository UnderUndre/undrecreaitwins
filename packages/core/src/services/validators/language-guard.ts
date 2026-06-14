import {
  ResponseValidator,
  ValidatorContext,
  ValidatorRunResult,
  LanguageGuardConfig
} from '../../types/validator.js';

type ScriptName = 'Common' | 'Latin' | 'Cyrillic' | 'Han' | 'Arabic' | 'Devanagari' | 'Hebrew' | 'Thai' | 'Hangul' | 'Katakana' | 'Hiragana' | 'Unknown';

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
];

const BCP47_TO_SCRIPTS: Record<string, string[]> = {
  ru: ['Cyrillic'],
  en: ['Latin'],
  zh: ['Han'],
  ar: ['Arabic'],
  hi: ['Devanagari'],
  he: ['Hebrew'],
  th: ['Thai'],
  ko: ['Hangul', 'Han', 'Latin'],
  ja: ['Hiragana', 'Katakana', 'Han', 'Latin'],
};

const BCP47_TO_NAME: Record<string, string> = {
  ru: 'Russian', en: 'English', zh: 'Chinese', ar: 'Arabic',
  hi: 'Hindi', he: 'Hebrew', th: 'Thai', ko: 'Korean', ja: 'Japanese',
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

function getAllowedScripts(allowedLanguages: string[]): Set<string> {
  const scripts = new Set<string>();
  for (const lang of allowedLanguages) {
    const mapped = BCP47_TO_SCRIPTS[lang];
    if (mapped) {
      for (const s of mapped) scripts.add(s);
    }
  }
  return scripts;
}

function getLanguageNames(allowedLanguages: string[]): string {
  return allowedLanguages
    .map(l => BCP47_TO_NAME[l] || l)
    .join(', ');
}

const SYSTEM_DEFAULT_FALLBACK = (allowedLanguages: string[]) =>
  `I can only respond in ${getLanguageNames(allowedLanguages)}.`;

export function buildLanguageDirective(allowedLanguages: string[]): string {
  const names = getLanguageNames(allowedLanguages);
  return `IMPORTANT: You must respond ONLY in ${names}. Do not use any other language or script.`;
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

    const { masked, maskedCount } = maskCode(reply);
    const scriptCounts = ScriptClassifier.analyze(masked);

    const totalChars = [...reply].length;
    const commonChars = scriptCounts.get('Common') || 0;
    const scriptChars = totalChars - commonChars - maskedCount;

    if (scriptChars === 0) {
      return {
        verdict: { decision: 'pass', confidence: 1.0 },
        mutatedText: reply,
        latencyMs: Date.now() - startTime,
      };
    }

    const allowedScripts = getAllowedScripts(config.allowedLanguages);

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
      if (!allowedScripts.has(script)) {
        nonCompliantChars += count;
        detectedScripts.push(script);
      }
    }

    const nonCompliantFraction = nonCompliantChars / scriptChars;
    const stripThreshold = config.stripThreshold ?? 0.05;
    const blockThreshold = config.blockThreshold ?? 0.30;

    if (nonCompliantFraction < stripThreshold) {
      return {
        verdict: {
          decision: 'pass',
          confidence: 1.0 - nonCompliantFraction,
          matchedPatterns: detectedScripts.length > 0 ? detectedScripts : undefined,
        },
        mutatedText: reply,
        latencyMs: Date.now() - startTime,
      };
    }

    if (nonCompliantFraction >= blockThreshold) {
      const fallback = config.fallbackMessage?.trim() || SYSTEM_DEFAULT_FALLBACK(config.allowedLanguages);
      return {
        verdict: {
          decision: 'block',
          confidence: nonCompliantFraction,
          reason: `non-compliant fraction ${nonCompliantFraction.toFixed(3)} ≥ blockThreshold ${blockThreshold}`,
          matchedPatterns: detectedScripts,
        },
        mutatedText: fallback,
        latencyMs: Date.now() - startTime,
      };
    }

    const strippedChars: string[] = [];
    for (const char of reply) {
      const code = char.codePointAt(0)!;
      const script = ScriptClassifier.classify(code);

      if (script === 'Common') {
        strippedChars.push(char);
        continue;
      }
      if (script === 'Unknown') {
        continue;
      }
      if (allowedScripts.has(script)) {
        strippedChars.push(char);
      }
    }

    const strippedText = strippedChars.join('');

    return {
      verdict: {
        decision: 'strip',
        confidence: nonCompliantFraction,
        reason: `non-compliant fraction ${nonCompliantFraction.toFixed(3)} ≥ stripThreshold ${stripThreshold}`,
        matchedPatterns: detectedScripts,
      },
      mutatedText: strippedText,
      latencyMs: Date.now() - startTime,
    };
  }
}
