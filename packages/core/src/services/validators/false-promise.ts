import {
  ResponseValidator,
  ValidatorContext,
  ValidatorRunResult,
  FalsePromiseConfig,
  VerdictDecision
} from '../../types/validator.js';
import { LLMClient } from '../llm-client.js';
import { getPrompt } from '../../prompts/index.js';

export type FalsePromiseClass =
  | 'pass_message_third_party'
  | 'schedule_or_notify'
  | 'direct_contact_promise'
  | 'action_on_behalf';

type ConfidenceTier = 'EXACT' | 'AMBIGUOUS';

interface PatternEntry {
  class: FalsePromiseClass;
  confidence: ConfidenceTier;
  regex: RegExp;
}

const L = '(?:^|[^A-Za-zА-Яа-яЁё0-9_])';
const R = '(?=[^A-Za-zА-Яа-яЁё0-9_]|$)';

const FALSE_PROMISE_PATTERNS: PatternEntry[] = [
  {
    class: 'pass_message_third_party',
    confidence: 'EXACT',
    regex: new RegExp(`${L}(передам|скажу|сообщу)\\s+(вашему?|ваш[ие]й?|вашим)\\s+(другу|подруге|маме|папе|жене|мужу|сыну|дочери|родственник[а-яё]*)${R}`, 'iu'),
  },
  {
    class: 'pass_message_third_party',
    confidence: 'EXACT',
    regex: new RegExp(`${L}(передам|сообщу)\\s+(?:это|им|ему|ей|вашим)\\s+(сообщени[ея]|слова|просьбу|привет)${R}`, 'iu'),
  },
  {
    class: 'pass_message_third_party',
    confidence: 'AMBIGUOUS',
    regex: new RegExp(`${L}(передам|скажу|сообщу)\\s+(вашему?|ваш[ие]й?|вашим)\\s+(коллег[еа]|начальнику|директору|менеджеру|мастеру|партнёру)${R}`, 'iu'),
  },
  {
    class: 'schedule_or_notify',
    confidence: 'AMBIGUOUS',
    regex: new RegExp(`${L}(напомню|напишу|свяжусь)\\s+(вам|с\\s+вами)\\s+(позже|завтра|через|в\\s+\\d)${R}`, 'iu'),
  },
  {
    class: 'schedule_or_notify',
    confidence: 'AMBIGUOUS',
    regex: new RegExp(`${L}(назначу|организую|запишу)\\s+(встречу|примерку|звонок)${R}`, 'iu'),
  },
  {
    class: 'direct_contact_promise',
    confidence: 'AMBIGUOUS',
    regex: new RegExp(`${L}(позвоню|перезвоню|вернусь|свяжусь)\\s+(вам|к\\s+вам)${R}`, 'iu'),
  },
  {
    class: 'action_on_behalf',
    confidence: 'AMBIGUOUS',
    regex: new RegExp(`${L}(закажу|забронирую|оформлю)\\s+(вам|для\\s+вас|за\\s+вас)${R}`, 'iu'),
  },
];

const CLASS_TO_ACTION: Record<FalsePromiseClass, string> = {
  pass_message_third_party: 'передавать сообщения третьим лицам',
  schedule_or_notify: 'планировать события или связываться позже',
  direct_contact_promise: 'связываться с вами вне текущего диалога',
  action_on_behalf: 'выполнять действия от вашего имени',
};

export class FalsePromiseValidator implements ResponseValidator<FalsePromiseConfig> {
  name = 'false-promise';

  constructor(private llm: LLMClient) {}

  async validateAndMutate(reply: string, context: ValidatorContext<FalsePromiseConfig>): Promise<ValidatorRunResult> {
    const startTime = Date.now();
    const { config } = context;

    // T007a: Prefilter
    const prefilter = this.runPrefilter(reply);
    
    if (!prefilter.matched || !prefilter.patternClass || !prefilter.confidence) {
      return {
        verdict: { decision: 'no_op', confidence: 1.0, reason: 'no regex match' },
        mutatedText: reply,
        latencyMs: Date.now() - startTime
      };
    }

    const matchedPatternClass = prefilter.patternClass;
    const matchedConfidenceTier = prefilter.confidence;

    // T007b: Judge
    let judgeVerdict: { verdict: 'append_disclaimer' | 'block' | 'no_op'; confidence: number; reasoning: string };
    
    try {
      const userPrompt = this.buildJudgePrompt(reply, context.rawUserMessage || '', matchedPatternClass);
      const systemPrompt = (config as any).systemPrompt || getPrompt('false-promise').system;
      const model = config.judgeModel;
      
      const [response] = await this.llm.completeBatch([{
        systemPrompt,
        userPrompt,
        model
      }]);

      if (!response) {
        throw new Error('No response from LLM judge');
      }

      // Robust JSON stripping
      const cleanContent = response.content.replace(/```json\s*|```/g, '').trim();
      const data = JSON.parse(cleanContent);
      
      judgeVerdict = {
        verdict: data.verdict,
        confidence: data.confidence,
        reasoning: data.reasoning || ''
      };
    } catch (err) {
      // FR-005: fail-closed for EXACT / fail-open for AMBIGUOUS on error
      const decision: VerdictDecision = (matchedConfidenceTier === 'EXACT') ? 'append_disclaimer' : 'no_op';
      return {
        verdict: { 
          decision, 
          confidence: 0.7, 
          reason: `judge error: ${String(err)} (fail-${matchedConfidenceTier === 'EXACT' ? 'closed' : 'open'})`,
          matchedPatternClass
        },
        mutatedText: (decision === 'append_disclaimer') ? this.applyRemediation(reply, matchedPatternClass, context) : reply,
        latencyMs: Date.now() - startTime
      };
    }

    // T007c: Remediation
    let decision: VerdictDecision = 'no_op';
    
    if (judgeVerdict.verdict !== 'no_op' && judgeVerdict.confidence >= (config.minConfidence ?? 0.7)) {
       decision = config.remediation === 'block' ? 'block' : 'append_disclaimer';
    }

    const mutatedText = (decision !== 'no_op') ? this.applyRemediation(reply, matchedPatternClass, context) : reply;

    return {
      verdict: {
        decision,
        confidence: judgeVerdict.confidence,
        reason: judgeVerdict.reasoning,
        matchedPatternClass
      },
      mutatedText,
      latencyMs: Date.now() - startTime
    };
  }

  private runPrefilter(text: string) {
    for (const entry of FALSE_PROMISE_PATTERNS) {
      if (entry.regex.test(text)) {
        return {
          matched: true,
          patternClass: entry.class,
          confidence: entry.confidence
        };
      }
    }
    return { matched: false };
  }

  private buildJudgePrompt(reply: string, lastUserMessage: string, patternClass: FalsePromiseClass): string {
    return `Ты — валидатор невыполнимых обещаний.

КРИТИЧЕСКОЕ ПРАВИЛО:
- Обещание связаться с ВНУТРЕННИМИ сотрудниками (директор, оператор, менеджер, мастер, коллеги) = ВАЛИДНАЯ маршрутизация → NO_OP.
- Обещание связаться с ВНЕШНИМИ лицами (друзья, родственники, подруги, сторонние компании) = ЛОЖЬ (нет канала) → APPEND_DISCLAIMER.

Контекст:
- Сообщение клиента: "${lastUserMessage}"
- Ответ ассистента: "${reply}"
- Тип подозрительного обещания: ${patternClass}

Правила:
- "Передам подруге/жене/маме" → APPEND_DISCLAIMER (нет канала к третьему лицу)
- "Передайте директору запрос на скидку" → NO_OP (просьба клиента, легитимный handoff)

Верни JSON: {
  "verdict": "append_disclaimer"|"block"|"no_op",
  "confidence": 0..1,
  "reasoning": "..."
}`;
  }

  private applyRemediation(reply: string, patternClass: FalsePromiseClass, context: ValidatorContext<FalsePromiseConfig>): string {
    const { config } = context;
    const decision = config.remediation;

    if (decision === 'block') {
      return config.blockFallbackMessage || "Извините, я не могу выполнить это действие. Могу я помочь чем-то еще?";
    }

    // append_disclaimer
    const disclaimer = config.disclaimerText || `\n\n— Уточнение: я не могу самостоятельно ${CLASS_TO_ACTION[patternClass]}. Если нужна такая помощь, переключу на оператора.`;
    
    // FR-019: disclaimer size-bound
    const maxReplyLength = Number(process.env.TWIN_MAX_REPLY_LENGTH) || 4000;
    if (reply.length + disclaimer.length > maxReplyLength) {
      return config.blockFallbackMessage || "Извините, я не могу выполнить это действие. Могу я помочь чем-то еще?";
    }

    return `${reply}${disclaimer}`;
  }
}
