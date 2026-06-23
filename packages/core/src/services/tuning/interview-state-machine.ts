import { redisHelper } from './redis-helper.js';
import { TuningDraftRepository } from './tuning-draft-repository.js';
import { LLMClient } from '../llm-client.js';
import { EXTRACTION_PROMPT_CONTENT } from './extraction-prompt.js';
import type { InterviewSession } from '../../types/tuning.js';

const QUESTION_BANK = [
  { id: 'q1', text: 'Какие основные задачи должен выполнять ассистент?' },
  { id: 'q2', text: 'Какой стиль общения предпочтителен? Формальный или неформальный?' },
  { id: 'q3', text: 'Какие темы ассистент НЕ должен обсуждать?' },
  { id: 'q4', text: 'Какие документы или инструкции должны быть в базе знаний?' },
  { id: 'q5', text: 'Какие этапы обработки запроса нужны? (сбор информации, уточнение, ответ)' },
  { id: 'q6', text: 'Как ассистент должен обрабатывать неполные или неясные запросы?' },
  { id: 'q7', text: 'Какие типы ответов должен поддерживать ассистент? (текст, ссылки, таблицы)' },
];

const draftRepo = new TuningDraftRepository();
const llm = new LLMClient();

export class InterviewStateMachine {
  async startSession(tenantId: string, personaId: string, userId: string): Promise<{ current: number; total: number }> {
    const session: InterviewSession = {
      personaId,
      currentQuestion: 0,
      answers: [],
      total: QUESTION_BANK.length,
      skipped: [],
      createdAt: Date.now(),
    };
    const key = redisHelper.interviewKey(tenantId, personaId, userId);
    await redisHelper.set(key, session, 1800);
    return { current: 0, total: QUESTION_BANK.length };
  }

  async getNextQuestion(tenantId: string, personaId: string, userId: string): Promise<{
    question: string;
    questionId: string;
    total: number;
    current: number;
  } | { draftId: string; status: 'ready' }> {
    const key = redisHelper.interviewKey(tenantId, personaId, userId);
    const session = await redisHelper.get<InterviewSession>(key);
    if (!session) {
      const started = await this.startSession(tenantId, personaId, userId);
      return { question: QUESTION_BANK[0]!.text, questionId: 'q1', ...started };
    }

    if (session.currentQuestion >= QUESTION_BANK.length) {
      return this.compileDraft(tenantId, personaId, userId, session);
    }

    const question = QUESTION_BANK[session.currentQuestion]!;
    return {
      question: question.text,
      questionId: question.id,
      total: session.total,
      current: session.currentQuestion + 1,
    };
  }

  async submitAnswer(tenantId: string, personaId: string, userId: string, questionId: string, answer: string): Promise<boolean> {
    const key = redisHelper.interviewKey(tenantId, personaId, userId);
    const session = await redisHelper.get<InterviewSession>(key);
    if (!session) return false;

    const qIdx = QUESTION_BANK.findIndex(q => q.id === questionId);
    if (qIdx === -1) return false;

    session.answers.push({
      questionId,
      question: QUESTION_BANK[qIdx]!.text,
      answer,
      skipped: false,
    });
    session.currentQuestion = Math.max(session.currentQuestion, qIdx + 1);

    await redisHelper.set(key, session, 1800);
    return true;
  }

  private async compileDraft(
    tenantId: string,
    personaId: string,
    userId: string,
    session: InterviewSession,
  ): Promise<{ draftId: string; status: 'ready' }> {
    const answersText = session.answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');

    try {
      const response = await llm.complete({
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT_CONTENT },
          { role: 'user', content: `Interview answers:\n${answersText}` },
        ],
        responseFormat: { type: 'json_object' },
        tenantId,
        personaId,
      });

      let extracted: any;
      try {
        extracted = response.content ? JSON.parse(response.content) : {};
      } catch {
        extracted = { systemPrompt: response.content };
      }

      const draft = await draftRepo.create(tenantId, {
        personaId,
        method: 'interview',
        systemPrompt: extracted.systemPrompt?.slice(0, 8000) || undefined,
        funnelConfig: extracted.funnelStages ? { funnelStages: extracted.funnelStages } : undefined,
        validatorToggles: extracted.validatorToggles || null,
        confidence: extracted.confidence || 'medium',
      });

      await draftRepo.update(tenantId, draft.id, { status: 'ready' });

      const key = redisHelper.interviewKey(tenantId, personaId, userId);
      await redisHelper.del(key);

      return { draftId: draft.id, status: 'ready' };
    } catch (err: any) {
      const draft = await draftRepo.create(tenantId, {
        personaId,
        method: 'interview',
      });
      await draftRepo.update(tenantId, draft.id, {
        status: 'failed',
        error: (err?.message || 'INTERVIEW_COMPILE_ERROR').slice(0, 500),
      });

      const key = redisHelper.interviewKey(tenantId, personaId, userId);
      await redisHelper.del(key);

      return { draftId: draft.id, status: 'ready' };
    }
  }
}
