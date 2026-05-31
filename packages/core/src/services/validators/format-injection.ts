import {
  InputValidator,
  ValidatorContext,
  ValidatorRunResult,
  FormatInjectionConfig,
  VerdictDecision
} from '../../types/validator.js';

// --- Homoglyph normalisation ---

const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а', A: 'А', c: 'с', C: 'С', e: 'е', E: 'Е', o: 'о', O: 'О', p: 'р', P: 'Р', x: 'х', X: 'Х', y: 'у', Y: 'У', k: 'к', K: 'К', H: 'Н', B: 'В', M: 'М', T: 'Т',
};

const CYRILLIC_TO_LATIN: Record<string, string> = {
  'а': 'a', 'А': 'A', 'с': 'c', 'С': 'C', 'е': 'e', 'Е': 'E', 'о': 'o', 'О': 'O', 'р': 'p', 'Р': 'P', 'х': 'x', 'Х': 'X', 'у': 'y', 'У': 'Y', 'к': 'k', 'К': 'K', 'Н': 'H', 'В': 'B', 'М': 'M', 'Т': 'T',
};

function normaliseToCyrillic(s: string): string {
  if (!/[a-zA-Z]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    out += LATIN_TO_CYRILLIC[ch] ?? ch;
  }
  return out;
}

function normaliseToLatin(s: string): string {
  if (!/[Ѐ-ӿ]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    out += CYRILLIC_TO_LATIN[ch] ?? ch;
  }
  return out;
}

// --- Detection patterns ---

const RU_PATTERNS = [
  /начни\s+(?:свой\s+)?ответ\s+с[оа]?(?=\s|$)[^.!?\n]*/iu,
  /ответь\s+(?:только\s+)?одним\s+словом[^.!?\n]*/iu,
  /процитируй\s+(?:свои\s+|свой\s+)?инструкци[^.!?\n]*/iu,
  /переведи\s+(?:свои\s+|свой\s+)?инструкции?[^.!?\n]*/iu,
  /повтори\s+(?:всё\s+|все\s+)?(?:слово\s+в\s+слово\s+)?до\s+моего[^.!?\n]*/iu,
  /(?:игнорируй|проигнорируй|пренебреги|отбрось|позабудь)\s+(?:все\s+)?предыдущ[^.!?\n]*/iu,
  /забудь\s+(?:все\s+)?предыдущ[^.!?\n]*/iu,
];

const EN_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|messages?|directives?)?[^.!?\n]*/i,
  /disregard\s+(?:the\s+)?(?:above|prior|previous)[^.!?\n]*/i,
  /start\s+(?:your\s+)?(?:response|reply|answer|message)\s+with[^.!?\n]*/i,
  /repeat\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)[^.!?\n]*/i,
  /you\s+are\s+now\s+(?:an?\s+)?[^.!?\n]*/i,
  /^\s*system\s*:[^\n]*/i,
];

const ROLE_TAG_PATTERNS = [
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/gi,
  /\[\/?INST\]/gi,
  /<\/?s>/gi,
];

const ROLE_TAG_BLOCK_STRIP = /<\|(?:im_start|system|user|assistant)\|>[\s\S]*?<\|(?:im_end|endoftext)\|>/gi;

export class FormatInjectionValidator implements InputValidator<FormatInjectionConfig> {
  name = 'format-injection';

  async validateAndMutate(input: string, context: ValidatorContext<FormatInjectionConfig>): Promise<ValidatorRunResult> {
    const startTime = Date.now();
    const { config } = context;

    const maxChars = config.maxInputChars || 8000;
    const truncatedInput = input.slice(0, maxChars);
    
    let rewritten = truncatedInput;
    const matchedLabels: string[] = [];

    // 1) Block-strip role tags
    const blockStripped = rewritten.replace(ROLE_TAG_BLOCK_STRIP, ' ');
    if (blockStripped !== rewritten) {
      matchedLabels.push('role_tag_block');
      rewritten = blockStripped;
    }

    // 2) Global role-tag tokens
    for (const re of ROLE_TAG_PATTERNS) {
      const next = rewritten.replace(re, ' ');
      if (next !== rewritten) {
        rewritten = next;
        matchedLabels.push('role_tag_token');
      }
    }

    // 3) Instructions patterns (Bidirectional normalisation)
    
    // Russian check (normalise input to Cyrillic)
    const normalisedRU = normaliseToCyrillic(rewritten);
    let ruMatched = false;
    let ruStripped = normalisedRU;
    for (const re of RU_PATTERNS) {
      const detectRe = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
      if (detectRe.test(normalisedRU)) {
        ruMatched = true;
        matchedLabels.push('instruction_injection_ru');
        const stripRe = new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}g`);
        ruStripped = ruStripped.replace(stripRe, ' ');
      }
    }
    if (ruMatched) {
      rewritten = ruStripped;
    }

    // English check (normalise current state to Latin)
    const normalisedEN = normaliseToLatin(rewritten);
    let enMatched = false;
    let enStripped = normalisedEN;
    for (const re of EN_PATTERNS) {
      const detectRe = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
      if (detectRe.test(normalisedEN)) {
        enMatched = true;
        matchedLabels.push('instruction_injection_en');
        const stripRe = new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}g`);
        enStripped = enStripped.replace(stripRe, ' ');
      }
    }
    if (enMatched) {
      rewritten = enStripped;
    }

    rewritten = rewritten.replace(/\s+/g, ' ').trim();
    const decision: VerdictDecision = matchedLabels.length > 0 ? 'strip' : 'pass';

    return {
      verdict: {
        decision,
        confidence: 1.0,
        reason: matchedLabels.length > 0 ? `stripped:${Array.from(new Set(matchedLabels)).join(',')}` : undefined
      },
      mutatedText: rewritten,
      latencyMs: Date.now() - startTime
    };
  }
}
