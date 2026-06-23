import { LLMClient } from '../llm-client.js';
import { TuningDraftRepository } from './tuning-draft-repository.js';
import { groundingEngine } from '../index.js';
import { EXTRACTION_PROMPT_CONTENT } from './extraction-prompt.js';
import type { ExtractionOutput } from '../../types/tuning.js';

const llm = new LLMClient();
const draftRepo = new TuningDraftRepository();

export class DocExtractionPipeline {
  async run(draftId: string, tenantId: string, personaId: string): Promise<void> {
    try {
      const chunks = await groundingEngine.query('', tenantId, personaId);

      if (!chunks || chunks.length === 0) {
        await draftRepo.update(tenantId, draftId, {
          status: 'failed',
          error: 'NO_DOCUMENTS',
        });
        return;
      }

      const concatenated = chunks
        .slice(0, 20)
        .map(c => c.text)
        .join('\n---\n')
        .slice(0, 32_000);

      const extractionTimeoutMs = parseInt(process.env.TUNING_EXTRACTION_TIMEOUT_MS || '55000', 10);
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), extractionTimeoutMs);

      let response;
      try {
        response = await llm.complete({
          messages: [
            { role: 'system', content: EXTRACTION_PROMPT_CONTENT },
            { role: 'user', content: `Documents:\n${concatenated}` },
          ],
          responseFormat: { type: 'json_object' },
          tenantId,
          personaId,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      let extracted: ExtractionOutput;
      try {
        extracted = JSON.parse(response.content) as ExtractionOutput;
      } catch {
        await draftRepo.update(tenantId, draftId, {
          status: 'ready',
          systemPrompt: response.content.slice(0, 4000),
          funnelConfig: undefined,
          confidence: 'low',
        });
        return;
      }

      if (!extracted.systemPrompt && !extracted.funnelStages) {
        await draftRepo.update(tenantId, draftId, {
          status: 'failed',
          error: 'INVALID_EXTRACTION_OUTPUT',
        });
        return;
      }

      await draftRepo.update(tenantId, draftId, {
        status: 'ready',
        systemPrompt: extracted.systemPrompt?.slice(0, 8000) || undefined,
        funnelConfig: extracted.funnelStages ? { funnelStages: extracted.funnelStages } : undefined,
        validatorToggles: extracted.validatorToggles || null,
        confidence: extracted.confidence || 'medium',
      });
    } catch (err: any) {
      const errorMsg = err?.message || 'UNKNOWN_PIPELINE_ERROR';
      if (err?.name === 'AbortError' || errorMsg === 'LLM_TIMEOUT') {
        await draftRepo.update(tenantId, draftId, {
          status: 'failed',
          error: 'LLM_TIMEOUT',
        });
      } else {
        await draftRepo.update(tenantId, draftId, {
          status: 'failed',
          error: errorMsg.slice(0, 500),
        });
      }
    }
  }
}
