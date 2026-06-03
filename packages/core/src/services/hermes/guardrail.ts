import type { AgentStepEvent } from './hermes-executor.js';

export interface GuardrailConfig {
  maxLoopIterations: number;
  maxTokensPerTurn: number;
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  filteredContent?: string;
}

export function checkBudget(
  iterations: number,
  tokens: number,
  config: GuardrailConfig,
): GuardrailResult {
  if (iterations > config.maxLoopIterations) {
    return { allowed: false, reason: `loop iterations ${iterations} exceeds cap ${config.maxLoopIterations}` };
  }
  if (tokens > config.maxTokensPerTurn) {
    return { allowed: false, reason: `tokens ${tokens} exceeds cap ${config.maxTokensPerTurn}` };
  }
  return { allowed: true };
}

export async function validateOutput(
  output: string,
  validators: Array<(text: string) => Promise<{ pass: boolean; reason?: string }>>,
): Promise<GuardrailResult> {
  for (const validator of validators) {
    try {
      const result = await validator(output);
      if (!result.pass) {
        return { allowed: false, reason: result.reason ?? 'Validator rejected output' };
      }
    } catch (err) {
      // Fail closed: validator error = output not allowed
      return {
        allowed: false,
        reason: `Validator error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { allowed: true };
}

export function extractFinalAnswer(steps: AgentStepEvent[]): string {
  const answerStep = steps.findLast(s => s.type === 'answer');
  return answerStep?.content ?? '';
}
