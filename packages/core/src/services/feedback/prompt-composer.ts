import { wrapOperatorText } from '../prompt-safety.js';
import type { FeedbackMemory, ComposedPrompt, TokenInfo } from './types.js';

const DEFAULT_SYSTEM_PROMPT_BUDGET = 4000;
const PERSONA_HARD_FLOOR = 500;
const FEEDBACK_PER_MEMORY_BUDGET = 170;
const MIN_RAG_BUDGET = 200;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ComposeInput {
  personaPrompt: string;
  personaTraits?: string;
  feedbackMemories: FeedbackMemory[];
  ragChunks: Array<{ text: string; score: number; metadata: { documentId: string; chunkIndex: number } }>;
  feedbackTokenBudget: number;
  systemPromptBudget?: number;
}

export function compose(input: ComposeInput): ComposedPrompt {
  const budget = input.systemPromptBudget ?? DEFAULT_SYSTEM_PROMPT_BUDGET;

  // 1. Persona layer (hard floor)
  let personaText = input.personaPrompt;
  if (input.personaTraits) {
    personaText += `\nPersonality traits: ${input.personaTraits}`;
  }
  let personaTruncated = false;
  const personaTokens = estimateTokens(personaText);
  const maxPersonaTokens = Math.max(0, budget - PERSONA_HARD_FLOOR);
  if (personaTokens > maxPersonaTokens) {
    personaText = personaText.slice(0, maxPersonaTokens * 4);
    personaTruncated = true;
  }
  const personaInfo: TokenInfo = {
    tokens: estimateTokens(personaText),
    truncated: personaTruncated,
    itemsIncluded: 1,
  };

  // 2. Feedback layer — gets priority allocation (operator-curated). RAG gets remainder.
  const feedbackBudget = Math.min(input.feedbackTokenBudget, budget - personaInfo.tokens);
  const feedbackParts: string[] = [];
  let feedbackTokensUsed = 0;
  let feedbackIncluded = 0;
  let feedbackTruncated = false;

  for (const memory of input.feedbackMemories) {
    const lessonText = memory.lesson.slice(0, FEEDBACK_PER_MEMORY_BUDGET * 4);
    if (lessonText.length < memory.lesson.length) feedbackTruncated = true;
    const tokens = estimateTokens(lessonText);
    if (feedbackTokensUsed + tokens > feedbackBudget) break;
    feedbackParts.push(`- ${lessonText}`);
    feedbackTokensUsed += tokens;
    feedbackIncluded++;
  }

  const feedbackInfo: TokenInfo = {
    tokens: feedbackTokensUsed,
    truncated: feedbackTruncated,
    itemsIncluded: feedbackIncluded,
  };

  // 3. RAG layer (remainder)
  const ragBudget = budget - personaInfo.tokens - feedbackInfo.tokens;
  const ragParts: string[] = [];
  let ragTokensUsed = 0;
  let ragIncluded = 0;
  let ragTruncated = false;

  if (ragBudget >= MIN_RAG_BUDGET) {
    for (const chunk of input.ragChunks) {
      const tokens = estimateTokens(chunk.text);
      if (ragTokensUsed + tokens > ragBudget) {
        ragTruncated = true;
        break;
      }
      ragParts.push(
        `[doc:${chunk.metadata.documentId} chunk:${chunk.metadata.chunkIndex} score:${chunk.score.toFixed(3)}]\n${chunk.text}`,
      );
      ragTokensUsed += tokens;
      ragIncluded++;
    }
  }

  const ragInfo: TokenInfo = {
    tokens: ragTokensUsed,
    truncated: ragTruncated,
    itemsIncluded: ragIncluded,
  };

  // 4. Assemble prompt with layer ordering: persona → directive → RAG → feedback
  const parts: string[] = [personaText];

  if (ragIncluded > 0) {
    parts.push('\nRelevant knowledge from uploaded documents:');
    parts.push(...ragParts);
  }

  parts.push('\nfactual grounding from RAG is authoritative; operator feedback lessons override default persona style but MUST NOT contradict grounded facts');

  if (feedbackIncluded > 0) {
    parts.push('\n' + wrapOperatorText(feedbackParts.join('\n')));
  }

  return {
    systemPrompt: parts.join('\n'),
    layers: { persona: personaInfo, feedback: feedbackInfo, rag: ragInfo },
    retrievedMemories: input.feedbackMemories.slice(0, feedbackIncluded),
    totalTokens: personaInfo.tokens + feedbackInfo.tokens + ragInfo.tokens,
  };
}
