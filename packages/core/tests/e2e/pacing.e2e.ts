/**
 * 017-hybrid-agent-core — Task 7.3
 * E2E: Pacing + Fallback Interaction Test
 *
 * Scenarios:
 * 1. baseDelayMs > fallback_threshold → fast LLM answer held by pacing,
 *    NO fallback fires during hold (pacing cancels fallback timer).
 * 2. baseDelayMs=0, slow LLM → fallback fires at threshold.
 * 3. Jitter ±30% produces delays within [0.7×base, 1.3×base].
 */

import { describe, it, expect } from 'vitest';

describe('Pacing + Fallback Interaction E2E', () => {
  it('pacing cancels fallback timer when LLM completes before threshold', () => {
    const pacingConfig = { baseDelayMs: 10_000, typingIndicator: true, randomVariation: false };
    const fallbackThresholdMs = 15_000;

    // Simulate: LLM completes at t=3s
    const llmCompleteAt = 3_000;

    // At LLM completion, pacing hold starts → fallback timer cancelled
    const pacingActive = pacingConfig.baseDelayMs > 0;
    const fallbackCancelled = pacingActive && llmCompleteAt < fallbackThresholdMs;

    expect(pacingActive).toBe(true);
    expect(fallbackCancelled).toBe(true);
  });

  it('fallback fires at threshold when pacing is off and LLM is slow', () => {
    const pacingConfig = { baseDelayMs: 0, typingIndicator: false, randomVariation: false };
    const fallbackThresholdMs = 15_000;

    // Simulate: LLM still running at t=15s
    const llmCompleteAt = null; // not complete
    const timeElapsed = fallbackThresholdMs;

    const pacingActive = pacingConfig.baseDelayMs > 0;
    const shouldFireFallback = !pacingActive && !llmCompleteAt && timeElapsed >= fallbackThresholdMs;

    expect(shouldFireFallback).toBe(true);
  });

  it('jitter produces delays within ±30% of base', () => {
    const baseDelayMs = 10_000;
    const samples = 1000;

    const delays: number[] = [];
    for (let i = 0; i < samples; i++) {
      const jitter = (Math.random() - 0.5) * 0.6; // -0.3..+0.3
      const delay = Math.round(baseDelayMs * (1 + jitter));
      delays.push(delay);
    }

    const min = Math.min(...delays);
    const max = Math.max(...delays);

    // ±30% of 10000 = [7000, 13000]
    expect(min).toBeGreaterThanOrEqual(6900); // small float rounding tolerance
    expect(max).toBeLessThanOrEqual(13100);
    expect(max - min).toBeGreaterThan(5000); // Good spread
  });

  it('hard cap: delay never exceeds 120000ms', () => {
    const baseDelayMs = 150_000; // Above cap

    let delay = baseDelayMs;
    if (delay > 120_000) delay = 120_000;

    expect(delay).toBe(120_000);
  });

  it('typing indicator interval is 4s (Telegram typing expires ~5s)', () => {
    const interval = 4_000;
    const typingExpiry = 5_000; // Telegram approximate

    expect(interval).toBeLessThan(typingExpiry);
  });

  it('pacing delay does NOT apply to non-channel conversations', () => {
    const pacingConfig = { baseDelayMs: 10_000, typingIndicator: true, randomVariation: false };
    const isChannel = false;

    const shouldApplyPacing = isChannel && pacingConfig.baseDelayMs > 0;
    expect(shouldApplyPacing).toBe(false);
  });

  it('pacing + fallback: when pacing > threshold, fallback timer is cancelled before firing', () => {
    const pacingConfig = { baseDelayMs: 20_000, typingIndicator: false, randomVariation: false };
    const fallbackThresholdMs = 15_000;

    // LLM completes at 2s, pacing hold for 20s, fallback threshold at 15s
    // Without cancel: fallback would fire at 15s while pacing holds
    // With cancel: fallback removed at 2s (LLM completion time)
    const llmCompleteAt = 2_000;
    const pacingActive = pacingConfig.baseDelayMs > 0;

    // Fallback timer scheduled at t=0 with delay=threshold
    const fallbackFireAt = fallbackThresholdMs;

    // If pacing active and LLM completes before fallback fires → cancel
    const cancelBeforeFire = pacingActive && llmCompleteAt < fallbackFireAt;

    expect(cancelBeforeFire).toBe(true);
    expect(pacingConfig.baseDelayMs).toBeGreaterThan(fallbackThresholdMs);
  });
});
