/**
 * NFR-6: Per-turn metrics tracker for funnel generative paths.
 *
 * Tracks:
 *  - llm_calls_total: count of ALL LLM calls in this turn
 *  - llm_cost_total: estimated token cost (prompt + completion)
 *  - reruns_used: count of reruns (banned retry + anti-repeat + retell)
 *  - reruns_max / llm_calls_max: from config
 *  - pipeline_steps: which steps fired/skipped and why
 */

export type PipelineStep =
  | 'adaptive_intro'
  | 'main_gen'
  | 'banned_check'
  | 'anti_repeat'
  | 'contextual_retell'
  | 'slot_extraction'
  | 'intent_classify'
  | 'anytime_trigger';

export interface PipelineStepRecord {
  step: PipelineStep;
  fired: boolean;
  skipped: boolean;
  reason?: string;
}

export interface TurnMetricsSnapshot {
  llm_calls_total: number;
  llm_cost_total: number;
  reruns_used: number;
  reruns_max: number;
  llm_calls_max: number;
  pipeline_steps: PipelineStepRecord[];
}

export class TurnMetrics {
  private llmCalls = 0;
  private llmCost = 0;
  private rerunsUsed = 0;
  private steps = new Map<PipelineStep, PipelineStepRecord>();

  constructor(
    private rerunsMax: number,
    private llmCallsMax: number,
  ) {}

  /** Override max values from actual funnel config (NFR-6). */
  setLimits(rerunsMax: number, llmCallsMax: number): void {
    this.rerunsMax = rerunsMax;
    this.llmCallsMax = llmCallsMax;
  }

  /** Record an LLM call (add token usage). */
  recordLLMCall(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    this.llmCalls++;
    this.llmCost += usage.total_tokens;
  }

  /** Increment rerun counter. Returns false if budget exhausted. */
  recordRerun(): boolean {
    if (this.rerunsUsed >= this.rerunsMax) return false;
    this.rerunsUsed++;
    return true;
  }

  /** Mark a pipeline step as fired. */
  stepFired(step: PipelineStep): void {
    this.steps.set(step, { step, fired: true, skipped: false });
  }

  /** Mark a pipeline step as skipped with reason. */
  stepSkipped(step: PipelineStep, reason: string): void {
    this.steps.set(step, { step, fired: false, skipped: true, reason });
  }

  /** Check if LLM budget remains. */
  hasLLMBudget(): boolean {
    return this.llmCalls < this.llmCallsMax;
  }

  /** Check if rerun budget remains. */
  hasRerunBudget(): boolean {
    return this.rerunsUsed < this.rerunsMax;
  }

  get llmCallsTotal(): number {
    return this.llmCalls;
  }

  get llmCostTotal(): number {
    return this.llmCost;
  }

  get rerunsUsedCount(): number {
    return this.rerunsUsed;
  }

  /** Remaining reruns in budget. */
  get rerunsRemaining(): number {
    return Math.max(0, this.rerunsMax - this.rerunsUsed);
  }

  /** Build the snapshot for emission. */
  snapshot(): TurnMetricsSnapshot {
    const allSteps: PipelineStep[] = [
      'adaptive_intro', 'main_gen', 'banned_check', 'anti_repeat',
      'contextual_retell', 'slot_extraction', 'intent_classify', 'anytime_trigger',
    ];

    return {
      llm_calls_total: this.llmCalls,
      llm_cost_total: this.llmCost,
      reruns_used: this.rerunsUsed,
      reruns_max: this.rerunsMax,
      llm_calls_max: this.llmCallsMax,
      pipeline_steps: allSteps.map(s => this.steps.get(s) ?? { step: s, fired: false, skipped: true, reason: 'not_reached' }),
    };
  }
}
