import { eq } from 'drizzle-orm';
import { LLMClient } from '../llm-client.js';
import { TuningDraftRepository } from './tuning-draft-repository.js';
import { groundingEngine } from '../index.js';
import { retrieveBigContext } from '../grounding/retrieval.js';
import { EXTRACTION_PROMPT_CONTENT } from './extraction-prompt.js';
import { db } from '../../db.js';
import { personas } from '../../models/personas.js';
import { tenants } from '../../models/tenants.js';
import type { ExtractionOutput } from '../../types/tuning.js';

const llm = new LLMClient();
const draftRepo = new TuningDraftRepository();

export class DocExtractionPipeline {
  async run(draftId: string, tenantId: string, personaId: string): Promise<void> {
    try {
      const effectiveMode = await this.resolveGroundingMode(tenantId, personaId);

      let concatenated: string;

      if (effectiveMode === 'big-context') {
        const docs = await retrieveBigContext(tenantId, personaId);

        if (docs.length === 0) {
          await draftRepo.update(tenantId, draftId, {
            status: 'failed',
            error: 'NO_DOCUMENTS',
          });
          return;
        }

        concatenated = docs
          .slice(0, 10)
          .map(d => d.text)
          .join('\n---\n')
          .slice(0, 32_000);
      } else {
        const chunks = await groundingEngine.query('', tenantId, personaId);

        if (!chunks || chunks.length === 0) {
          await draftRepo.update(tenantId, draftId, {
            status: 'failed',
            error: 'NO_DOCUMENTS',
          });
          return;
        }

        concatenated = chunks
          .slice(0, 20)
          .map(c => c.text)
          .join('\n---\n')
          .slice(0, 32_000);
      }

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

  private async resolveGroundingMode(tenantId: string, personaId: string): Promise<'vector' | 'big-context'> {
    const [personaRow] = await db
      .select({ groundingMode: personas.groundingMode })
      .from(personas)
      .where(eq(personas.id, personaId));

    if (personaRow?.groundingMode) {
      return personaRow.groundingMode;
    }

    const [tenantRow] = await db
      .select({ groundingMode: tenants.groundingMode })
      .from(tenants)
      .where(eq(tenants.id, tenantId));

    if (tenantRow?.groundingMode) {
      return tenantRow.groundingMode;
    }

    return 'vector';
  }
}
