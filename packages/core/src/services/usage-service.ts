import { withTenantContext } from '../db.js';
import { usageEvents } from '../models/index.js';

type RecordUsageParams = {
  tenantId: string;
  personaId: string;
  conversationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export class UsageService {
  async record(params: RecordUsageParams): Promise<void> {
    await withTenantContext(params.tenantId, async (tx) => {
      await tx.insert(usageEvents).values({
        tenantId: params.tenantId,
        personaId: params.personaId,
        conversationId: params.conversationId,
        provider: params.provider,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        latencyMs: params.latencyMs,
      });
    });

    this.emitIfConfigured(params);
  }

  private emitIfConfigured(params: RecordUsageParams): void {
    const endpoint = process.env.USAGE_EMISSION_ENDPOINT;
    if (!endpoint) return;

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: params.tenantId,
        persona_id: params.personaId,
        conversation_id: params.conversationId,
        provider: params.provider,
        model: params.model,
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
        latency_ms: params.latencyMs,
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => {});
  }
}
