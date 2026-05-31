import {
  ResponseValidator,
  ValidatorContext,
  ValidatorRunResult,
  IdentityGuardConfig
} from '../../types/validator.js';

const R = '(?=[^A-Za-zА-Яа-яЁё0-9_]|$)';

// Detects "Are you a bot?" type questions in user messages
const IDENTITY_QUESTION_RE = new RegExp(
  `(?:^|[^A-Za-zА-Яа-яЁё0-9_])(ты|вы)\\s+(?:(?:бот|искусственн[А-Яа-яЁё]*\\s+интеллект|роб[ао]т|машин[ао]|программа|нейросет|чат[- ]?бот|ии)${R}|(?:живой|реальный|настоящий)\\s+(?:человек|оператор|менеджер)${R})`,
  'iu'
);

// Detects provider names or human-claims in assistant responses
const RESPONSE_LEAK_RE =
  /(Anthropic|OpenAI|GPT|Claude|ChatGPT|machine\s+learning|я\s+не\s+бот|реальный\s+человек|живой\s+человек|настоящий\s+человек)/iu;

const SYSTEM_DEFAULT_FALLBACK = "I'm an AI assistant. I can connect you with a human operator if you'd like.";

export class IdentityGuardValidator implements ResponseValidator<IdentityGuardConfig> {
  name = 'identity-and-provider-guard';

  async validateAndMutate(reply: string, context: ValidatorContext<IdentityGuardConfig>): Promise<ValidatorRunResult> {
    const startTime = Date.now();
    const { config, rawUserMessage } = context;

    // FR-022: length cap before regex evaluation (ReDoS bound)
    const maxChars = config.maxInputChars || 8000;
    const truncatedReply = reply.slice(0, maxChars);
    const truncatedUserMsg = rawUserMessage?.slice(0, maxChars) || '';

    // FR-008: Inspection logic
    const userAsked = config.applyToTier1 ? IDENTITY_QUESTION_RE.test(truncatedUserMsg) : false;
    const responseLeaks = RESPONSE_LEAK_RE.test(truncatedReply);

    if (!userAsked && !responseLeaks) {
      return {
        verdict: { decision: 'pass', confidence: 1.0 },
        mutatedText: reply,
        latencyMs: Date.now() - startTime
      };
    }

    const reason = userAsked
      ? responseLeaks
        ? 'identity_question_and_response_leak'
        : 'identity_question'
      : 'response_leak';

    const fallback = config.fallbackMessage?.trim() || SYSTEM_DEFAULT_FALLBACK;

    return {
      verdict: {
        decision: 'rewrite',
        confidence: 1.0,
        reason
      },
      mutatedText: fallback,
      latencyMs: Date.now() - startTime
    };
  }
}
