import type { FunnelSlot } from '@undrecreaitwins/shared';
import { LLMClient } from '../llm-client.js';
import type { TurnMetrics } from '../funnel/turn-metrics.js';

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
  constructor(private llmClient: LLMClient) {}

  async extractSlots(params: SlotExtractionInput & { tenantId: string; personaId: string; metrics?: TurnMetrics }): Promise<SlotExtractionResult> {
    const { userMessage, assistantReply, slotDefinitions, conversationSlots, tenantId, personaId } = params;

    // 1. Filter out locked slots (FR-019: locked = skip extraction)
    const extractableSlots = slotDefinitions.filter(s => !s.locked);

    if (extractableSlots.length === 0) {
      return { extracted: {}, confidence: 0 };
    }

    // 2. Build extraction prompt with ALL slot definitions
    const slotDescriptions = extractableSlots.map(s => {
      let desc = `- "${s.name}": ${s.description || 'user data'}`;
      if (s.enumValues && s.enumValues.length > 0) {
        desc += ` [allowed values: ${s.enumValues.join(', ')}]`;
      }
      return desc;
    }).join('\n');

    const existingSlotsJson = JSON.stringify(conversationSlots, null, 2);

    const systemPrompt = `Ты — сервис извлечения структурированных данных из диалога.

Задача: проанализируй диалог и извлеки значения слотов.

ОПРЕДЕЛЕНИЯ СЛОТОВ:
${slotDescriptions}

СУЩЕСТВУЮЩИЕ СЛОТЫ (уже извлечённые):
${existingSlotsJson}

ПРАВИЛА:
1. Возвращай ТОЛЬКО JSON объект с ключами = имена слотов, значения = извлечённые данные.
2. Если значение не найдено в диалоге — не включай ключ в ответ.
3. Для слотов с enum — используй ТОЛЬКО допустимые значения. Если значение не совпадает ни с одним из enum — не включай ключ.
4. Confidence: общая оценка достоверности извлечения (0.0 - 1.0).
5. Если слот уже существует в conversationSlots — НЕ перезаписывай его.

Формат ответа:
{
  "extracted": { "имя_слота": "значение" },
  "confidence": 0.85
}`;

    const userPrompt = `Диалог:
Пользователь: "${userMessage}"
Ассистент: "${assistantReply}"

Извлеки слоты из этого диалога:`;

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

      // Record LLM usage for NFR-6 metrics
      if (params.metrics) {
        params.metrics.recordLLMCall(response.usage);
      }

      // 3. Validate against schema: enum slots validation
      const validated = this.validateExtracted(parsed.extracted, extractableSlots, conversationSlots);

      return {
        extracted: validated,
        confidence: parsed.confidence
      };
    } catch (error) {
      console.error('[SlotExtractorService] Extraction failed:', error);
      return { extracted: {}, confidence: 0 };
    }
  }

  private parseResponse(content: string): { extracted: Record<string, unknown>; confidence: number } | null {
    try {
      // Strip markdown code fences if present
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

      // Skip if already exists (don't overwrite existing slots)
      if (key in existingSlots) {
        console.error(`[SlotExtractorService] Skipping overwrite of existing slot "${key}"`);
        continue;
      }

      // Enum validation (FR-020)
      if (slotDef.enumValues && slotDef.enumValues.length > 0) {
        if (typeof value === 'string' && slotDef.enumValues.includes(value)) {
          result[key] = value;
        } else {
          console.error(`[SlotExtractorService] Invalid enum value "${value}" for slot "${key}". Allowed: ${slotDef.enumValues.join(', ')}`);
          // Invalid → null (don't save garbage)
        }
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
