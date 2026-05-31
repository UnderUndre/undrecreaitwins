import { withTenantContext } from '../../db.js';
import { validatorConfigs, validatorRuns } from '../../models/validators.js';
import { eq, and } from 'drizzle-orm';
import type { 
  ResponseValidator, 
  InputValidator, 
  ValidatorRunResult,
  AnyValidatorConfig,
  ValidatorMode
} from '../../types/validator.js';
import { LLMClient } from '../llm-client.js';
import { FalsePromiseValidator } from './false-promise.js';
import { FormatInjectionValidator } from './format-injection.js';
import { IdentityGuardValidator } from './identity-guard.js';

export class ValidatorPipeline {
  private responseValidators: ResponseValidator[] = [];
  private inputValidators: InputValidator[] = [];

  constructor(llm: LLMClient) {
    this.responseValidators = [
      new FalsePromiseValidator(llm),
      new IdentityGuardValidator()
    ];
    this.inputValidators = [
      new FormatInjectionValidator()
    ];
  }

  async validateResponse(
    reply: string,
    context: {
      tenantId: string;
      personaId: string;
      conversationId: string;
      messageId?: string;
      rawUserMessage?: string;
    }
  ): Promise<string> {
    let currentText = reply;
    const originalText = reply;
    const results: Array<{ 
      validatorName: string; 
      result: ValidatorRunResult; 
      config: AnyValidatorConfig;
      isDryRun: boolean;
    }> = [];

    // FR-017: BLOCKING validators first, REWRITE validators last.
    const sortedValidators = [...this.responseValidators].sort((a, b) => {
      const isARewrite = a.name.includes('rewrite') || a.name === 'identity-and-provider-guard';
      const isBRewrite = b.name.includes('rewrite') || b.name === 'identity-and-provider-guard';
      
      if (isARewrite && !isBRewrite) return 1;
      if (!isARewrite && isBRewrite) return -1;
      return 0;
    });

    try {
      for (const validator of sortedValidators) {
        const startTime = Date.now();
        const config = await this.resolveConfig(context.tenantId, context.personaId, validator.name);
        
        try {
          // FR-022: per-validator wall-clock budget could be enforced here
          const runResult = await validator.validateAndMutate(currentText, {
            ...context,
            config
          });

          results.push({
            validatorName: validator.name,
            result: runResult,
            config,
            isDryRun: config.mode === 'dry-run'
          });

          if (config.mode === 'active') {
            currentText = runResult.mutatedText;
          }
        } catch (err) {
          // FR-016a: single validator failure
          results.push({
            validatorName: validator.name,
            result: {
              verdict: { decision: 'error', reason: String(err) },
              mutatedText: currentText,
              latencyMs: Date.now() - startTime
            },
            config,
            isDryRun: true
          });
        }
      }
    } catch (err) {
      // FR-016b: pipeline-level failure - safest reply already in currentText
    }

    // FR-019: Empty-output guard
    if (!currentText.trim()) {
      currentText = originalText.trim() ? originalText : "I am an AI assistant. How can I help you?";
    }

    // FR-016c: audit persistence is best-effort
    if (results.length > 0) {
      this.persistRuns(context, originalText, results).catch(err => {
        console.error('[ValidatorPipeline] Failed to persist runs', err);
      });
    }

    return currentText;
  }

  async validateInput(
    input: string,
    context: {
      tenantId: string;
      personaId: string;
    }
  ): Promise<string> {
    let currentText = input;
    for (const validator of this.inputValidators) {
      try {
        const config = await this.resolveConfig(context.tenantId, context.personaId, validator.name);
        const result = await validator.validateAndMutate(currentText, {
          ...context,
          config
        });
        if (config.mode === 'active') {
          currentText = result.mutatedText;
        }
      } catch (err) {
        // Input validation failure - deliver original or handle as needed
      }
    }
    return currentText;
  }

  /**
   * FR-019: Streaming-bypass telemetry.
   * Records a no_op entry when validation is skipped due to streaming.
   */
  async recordBypass(
    context: { tenantId: string; personaId: string; conversationId: string; messageId?: string },
    originalContent: string,
    reason: string = 'streaming_bypass'
  ) {
    return this.persistRuns(context, originalContent, [
      {
        validatorName: 'pipeline-bypass',
        result: {
          verdict: { decision: 'no_op', reason },
          mutatedText: originalContent,
          latencyMs: 0
        },
        isDryRun: true
      }
    ]);
  }

  private async resolveConfig(
tenantId: string, personaId: string, validatorName: string): Promise<AnyValidatorConfig> {
    try {
      return await withTenantContext(tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(validatorConfigs)
          .where(
            and(
              eq(validatorConfigs.tenantId, tenantId),
              eq(validatorConfigs.personaId, personaId),
              eq(validatorConfigs.validatorName, validatorName)
            )
          );

        if (row) {
          return {
            ...row.config as any,
            mode: row.mode as ValidatorMode
          };
        }

        // FR-015: Defaults
        const defaultMode: ValidatorMode = (validatorName === 'identity-and-provider-guard') ? 'dry-run' : 'active';
        return { mode: defaultMode } as AnyValidatorConfig;
      });
    } catch (err) {
      // Fail-safe defaults if DB is down
      const defaultMode: ValidatorMode = (validatorName === 'identity-and-provider-guard') ? 'dry-run' : 'active';
      return { mode: defaultMode } as AnyValidatorConfig;
    }
  }

  private async persistRuns(
    context: { tenantId: string; personaId: string; conversationId: string; messageId?: string },
    originalContent: string,
    results: Array<{ validatorName: string; result: ValidatorRunResult; isDryRun: boolean }>
  ) {
    return withTenantContext(context.tenantId, async (tx) => {
      const rows = results.map(r => ({
        tenantId: context.tenantId,
        personaId: context.personaId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        validatorName: r.validatorName,
        verdict: r.result.verdict.decision as any,
        confidence: r.result.verdict.confidence,
        matchedPatterns: r.result.verdict.matchedPatterns || [],
        originalContent: originalContent,
        remediatedContent: r.result.mutatedText,
        latencyMs: r.result.latencyMs,
        isDryRun: r.isDryRun
      }));

      await tx.insert(validatorRuns).values(rows);
    });
  }
}
