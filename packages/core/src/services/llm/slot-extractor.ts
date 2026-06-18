import type { FunnelSlot } from '@undrecreaitwins/shared';
import { LLMClient } from '../llm-client.js';
import type { TurnMetrics } from '../funnel/turn-metrics.js';
import { getPrompt, interpolate } from '../../prompts/index.js';
import type { Locale } from '../../prompts/types.js';

export interface SlotExtractionInput {
  userMessage: string;
  assistantReply: string;
  slotDefinitions: FunnelSlot[];
  conversationSlots: Record<string, unknown>;
}

export interface SlotExtractionResult {
  extracted: Record<string, unknown>;
  confidence: number;
}

export class SlotExtractorService {
  constructor(private llmClient: LLMClient, private locale: Locale = 'ru') {}

  async extractSlots(params: SlotExtractionInput & { tenantId: string; personaId: string; metrics?: TurnMetrics }): Promise<SlotExtractionResult> {
    const { userMessage, assistantReply, slotDefinitions, conversationSlots, tenantId, personaId } = params;

    const extractableSlots = slotDefinitions.filter(s => !s.locked);

    if (extractableSlots.length === 0) {
      return { extracted: {}, confidence: 0 };
    }

    const slotDescriptions = extractableSlots.map(s => {
      let desc = `- "${s.name}": ${s.description || 'user data'}`;
      if (s.enumValues && s.enumValues.length > 0) {
        desc += ` [allowed values: ${s.enumValues.join(', ')}]`;
      }
      return desc;
    }).join('\n');

    const existingSlotsJson = JSON.stringify(conversationSlots, null, 2);

    const tpl = getPrompt('slot-extraction', this.locale);

    const systemPrompt = interpolate(tpl.system, {
      slotDescriptions,
      existingSlotsJson,
    });

    const userPrompt = interpolate(tpl.userTemplate!, {
      userMessage,
      assistantReply,
    });

    try {
      const response = await this.llmClient.complete({
        tenantId,
        personaId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0,
        maxTokens: 500
      });

      const parsed = this.parseResponse(response.content);
      if (!parsed) {
        return { extracted: {}, confidence: 0 };
      }

      if (params.metrics) {
        params.metrics.recordLLMCall(response.usage);
      }

      const validated = this.validateExtracted(parsed.extracted, extractableSlots, conversationSlots);

      return {
        extracted: validated,
        confidence: parsed.confidence
      };
    } catch (error) {
      console.warn('[SlotExtractorService] Extraction failed:', error);
      return { extracted: {}, confidence: 0 };
    }
  }

  private parseResponse(content: string): { extracted: Record<string, unknown>; confidence: number } | null {
    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (typeof parsed !== 'object' || parsed === null) return null;

      const extracted = parsed.extracted ?? {};
      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;

      return { extracted, confidence };
    } catch {
      return null;
    }
  }

  private validateExtracted(
    extracted: Record<string, unknown>,
    slotDefs: FunnelSlot[],
    existingSlots: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(extracted)) {
      const slotDef = slotDefs.find(s => s.name === key);
      if (!slotDef) continue;

      if (key in existingSlots) {
        console.warn(`[SlotExtractorService] Skipping overwrite of existing slot "${key}"`);
        continue;
      }

      if (slotDef.enumValues && slotDef.enumValues.length > 0) {
        if (typeof value === 'string' && slotDef.enumValues.includes(value)) {
          result[key] = value;
        } else {
          console.warn(`[SlotExtractorService] Invalid enum value "${value}" for slot "${key}". Allowed: ${slotDef.enumValues.join(', ')}`);
        }
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
