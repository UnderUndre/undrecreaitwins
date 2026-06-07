import { describe, it, expect } from 'vitest';
import { routeTurn } from '../../../src/services/hermes/turn-router.js';

describe('Live-path routing (T016)', () => {
  it('non-scripted agent-enabled turn routes to agentic', () => {
    const decision = routeTurn({
      hasActiveFunnel: false,
      agentEnabled: true,
      hermesHealthy: true,
    });
    expect(decision.kind).toBe('agentic');
    expect(decision.reason).toContain('hermes agent');
  });

  it('scripted turn stays deterministic regardless of agentEnabled', () => {
    const decision = routeTurn({
      hasActiveFunnel: true,
      agentEnabled: true,
      hermesHealthy: true,
    });
    expect(decision.kind).toBe('scripted');
  });

  it('Hermes outage → fallback', () => {
    const decision = routeTurn({
      hasActiveFunnel: false,
      agentEnabled: true,
      hermesHealthy: false,
    });
    expect(decision.kind).toBe('fallback');
    expect(decision.reason).toContain('degraded');
  });

  it('agent not enabled → fallback to thin completion', () => {
    const decision = routeTurn({
      hasActiveFunnel: false,
      agentEnabled: false,
      hermesHealthy: true,
    });
    expect(decision.kind).toBe('fallback');
    expect(decision.reason).toContain('not enabled');
  });

  it('funnel + agent disabled → scripted (funnel wins)', () => {
    const decision = routeTurn({
      hasActiveFunnel: true,
      agentEnabled: false,
      hermesHealthy: false,
    });
    expect(decision.kind).toBe('scripted');
  });
});
