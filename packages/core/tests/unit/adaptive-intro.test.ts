import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveIntroService } from '../../src/services/llm/adaptive-intro.js';

describe('AdaptiveIntroService', () => {
  let llmClient: any;
  let service: AdaptiveIntroService;

  beforeEach(() => {
    llmClient = {
      complete: vi.fn(),
    };
    service = new AdaptiveIntroService(llmClient);
  });

  it('should generate a conversational bridge', async () => {
    llmClient.complete.mockResolvedValue({
      content: 'Ну, слушай, давай разберемся с этим.',
    });

    const result = await service.generateIntro({
      userMessage: 'Как дела?',
      fragmentObjective: 'Рассказать о компании',
      tenantId: 't1',
      personaId: 'p1',
    });

    expect(result).toBe('Ну, слушай, давай разберемся с этим.');
    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      personaId: 'p1',
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
    }));
  });

  it('should remove quotes from LLM response', async () => {
    llmClient.complete.mockResolvedValue({
      content: '"Так, ну по поводу этого..."',
    });

    const result = await service.generateIntro({
      userMessage: 'Что по цене?',
      fragmentObjective: 'Назвать цену',
      tenantId: 't1',
      personaId: 'p1',
    });

    expect(result).toBe('Так, ну по поводу этого...');
  });

  it('should return null on LLM failure', async () => {
    llmClient.complete.mockRejectedValue(new Error('LLM Down'));

    const result = await service.generateIntro({
      userMessage: 'Test',
      fragmentObjective: 'Test',
      tenantId: 't1',
      personaId: 'p1',
    });

    expect(result).toBeNull();
  });
});
