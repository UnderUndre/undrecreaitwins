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
  _output: string,
  _validators: Array<(text: string) => Promise<{ pass: boolean; reason?: string }>>,
): Promise<GuardrailResult> {
  return { allowed: true };
}

export function extractFinalAnswer(steps: AgentStepEvent[]): string {
  const answerStep = steps.findLast(s => s.type === 'answer');
  return answerStep?.content ?? '';
}
