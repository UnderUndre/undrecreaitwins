import type { 
  FunnelSlot, 
} from '@undrecreaitwins/shared';
import { FunnelRepository } from './funnel-repository.js';
import pino from 'pino';

const logger = pino();

export class SlotVerificationService {
  private failureCount = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
  private readonly CIRCUIT_BREAKER_COOLDOWN = 60000;
  private lastFailureTime = 0;

  constructor(
    private repository: FunnelRepository,
    private llmClient: any // Placeholder for LLM client
  ) {
      void this.llmClient; // Suppress unused property warning until implemented
  }

  public async verifySlots(
    tenantId: string,
    conversationId: string,
    message: string,
    slots: FunnelSlot[]
  ): Promise<void> {
    if (this.isCircuitOpen()) {
      logger.warn({ conversationId }, 'Slot verification skipped: Circuit breaker open');
      return;
    }

    try {
      await this.processVerificationWithRetry(tenantId, conversationId, message, slots);
      this.failureCount = 0;
    } catch (err) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      logger.error({ err, conversationId }, 'Slot verification failed');
    }
  }

  private isCircuitOpen(): boolean {
    if (this.failureCount >= this.CIRCUIT_BREAKER_THRESHOLD) {
      const elapsed = Date.now() - this.lastFailureTime;
      return elapsed < this.CIRCUIT_BREAKER_COOLDOWN;
    }
    return false;
  }

  private async processVerificationWithRetry(
    tenantId: string,
    conversationId: string,
    message: string,
    slots: FunnelSlot[]
  ): Promise<void> {
    let retries = 0;
    const MAX_RETRIES = 2;
    const BACKOFFS = [1000, 2000];

    while (retries <= MAX_RETRIES) {
      try {
        await this.extractAndPersist(tenantId, conversationId, message, slots);
        return;
      } catch (err) {
        if (retries === MAX_RETRIES) throw err;
        const delay = BACKOFFS[retries];
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      }
    }
  }

  private async extractAndPersist(
    tenantId: string,
    conversationId: string,
    message: string,
    slots: FunnelSlot[]
  ): Promise<void> {
    // 1. LLM call to extract slots
    const extracted = await this.callLLMExtract(tenantId, message, slots);
    
    if (Object.keys(extracted).length === 0) return;

    // 2. Persist with CAS retry
    let success = false;
    let casRetries = 0;
    const MAX_CAS_RETRIES = 3;

    while (!success && casRetries < MAX_CAS_RETRIES) {
      const state = await this.repository.getConversationState(conversationId);
      if (!state) return;

      const updatedSlots = { ...state.capturedSlots };
      for (const [name, value] of Object.entries(extracted)) {
        updatedSlots[name] = {
          value,
          verified: true,
          captured_at: new Date().toISOString()
        };
      }

      success = await this.repository.updateConversationState(
        conversationId,
        { capturedSlots: updatedSlots },
        state.version
      );

      if (!success) {
        casRetries++;
      }
    }

    if (!success) {
      logger.error({ conversationId }, 'Slot update failed after max CAS retries');
    }
  }

  private async callLLMExtract(_tenantId: string, _message: string, _slots: FunnelSlot[]): Promise<Record<string, any>> {
    // This is a placeholder for actual LLM call logic
    return {}; 
  }
}
