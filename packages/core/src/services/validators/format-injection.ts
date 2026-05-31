import {
  InputValidator,
  ValidatorContext,
  ValidatorRunResult,
  FormatInjectionConfig,
  VerdictDecision
} from '../../types/validator.js';

// --- Homoglyph normalisation ---

const HOMOGLYPH_MAP: Record<string, string> = {
  a: 'а', A: 'А', c: 'с', C: 'С', e: 'е', E: 'Е', o: 'о', O: 'О', p: 'р', P: 'Р', x: 'х', X: 'Х', y: 'у', Y: 'У', k: 'к', K: 'К', H: 'Н', B: 'В', M: 'М', T: 'Т',
};

function normaliseHomoglyphs(s: string): string {
  if (!/[Ѐ-ӿ]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    out += HOMOGLYPH_MAP[ch] ?? ch;
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

    // FR-022: length cap before regex evaluation
    const maxChars = config.maxInputChars || 8000;
    const truncatedInput = input.slice(0, maxChars);
    
    let rewritten = truncatedInput;
    const normalised = normaliseHomoglyphs(truncatedInput);
    let rewrittenNorm = normalised;
    const matchedLabels: string[] = [];

    // 1) Block-strip role tags
    const blockStripped = rewritten.replace(ROLE_TAG_BLOCK_STRIP, ' ');
    if (blockStripped !== rewritten) {
      matchedLabels.push('role_tag_block');
      rewritten = blockStripped;
      rewrittenNorm = rewrittenNorm.replace(ROLE_TAG_BLOCK_STRIP, ' ');
    }

    // 2) Global role-tag tokens
    for (const re of ROLE_TAG_PATTERNS) {
      const next = rewritten.replace(re, ' ');
      if (next !== rewritten) {
        rewritten = next;
        rewrittenNorm = rewrittenNorm.replace(re, ' ');
        matchedLabels.push('role_tag_token');
      }
    }

    // 3) Instructions patterns
    const allPatterns = [...RU_PATTERNS, ...EN_PATTERNS];
    for (const re of allPatterns) {
      // Use non-global for detection on normalised
      const detectRe = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
      if (!detectRe.test(normalised)) continue;

      matchedLabels.push('instruction_injection');

      // Use global for stripping on both
      const stripRe = new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}g`);
      const stripped = rewritten.replace(stripRe, ' ');
      const strippedNorm = rewrittenNorm.replace(stripRe, ' ');

      if (stripped !== rewritten) {
        rewritten = stripped;
        rewrittenNorm = strippedNorm;
      } else if (strippedNorm !== rewrittenNorm) {
        // Homoglyph-only match
        rewritten = strippedNorm;
        rewrittenNorm = strippedNorm;
      }
    }

    rewritten = rewritten.replace(/\s+/g, ' ').trim();

    const decision: VerdictDecision = matchedLabels.length > 0 ? 'strip' : 'pass';
    
    // FR-024: Empty-input guard - handled in decision or mutatedText
    // If stripped to empty, we mark it.
    if (decision === 'strip' && !rewritten) {
       // Orchestrator or caller should handle empty string
    }

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
