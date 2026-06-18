import { LLMClient } from '../llm-client.js';

export class AdaptiveIntroService {
  constructor(private llmClient: LLMClient) {}

  /**
   * Generates a short conversational "bridge" phrase to link the user's message
   * with the target funnel fragment.
   */
  public async generateIntro(params: {
    userMessage: string;
    fragmentObjective: string;
    tenantId: string;
    personaId: string;
  }): Promise<string | null> {
    const systemPrompt = `Ты — помощник, который пишет очень короткие (1 предложение) переходные фразы в диалоге.
Твоя задача: связать последнее сообщение пользователя с целью следующего этапа разговора.

ПРАВИЛА:
1. Пиши максимально разговорно и естественно.
2. Используй разговорные частицы: ну, же, ведь, короче, слушай.
3. Используй нижний регистр для коротких фраз, если это уместно.
4. Можешь опускать подлежащее (например, "Пойду уточню" вместо "Я пойду уточню").
5. Используй инверсию порядка слов для смыслового акцента.
6. Длина: максимум 100 символов.
7. Только одно предложение.
8. Не используй кавычки в ответе.

Цель фрагмента: ${params.fragmentObjective}`;

    const userPrompt = `Сообщение пользователя: "${params.userMessage}"
Напиши короткую переходную фразу-мостик:`;

    try {
      // Per FR-008: use assistan'ts BYOK provider. 
      // LLMClient.complete resolves this based on tenantId and personaId.
      const response = await this.llmClient.complete({
        tenantId: params.tenantId,
        personaId: params.personaId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        maxTokens: 50
      });

      let content = response.content.trim();
      // Remove quotes if LLM added them
      if (content.startsWith('"') && content.endsWith('"')) {
        content = content.slice(1, -1);
      }

      return content;
    } catch (error) {
      // Failure -> graceful skip (review fix C-F4)
      console.error('[AdaptiveIntroService] Failed to generate intro:', error);
      return null;
    }
  }
}
