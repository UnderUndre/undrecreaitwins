export type TurnKind = 'scripted' | 'agentic' | 'fallback';

export interface RoutingDecision {
  kind: TurnKind;
  reason: string;
}

export interface RouterContext {
  hasActiveFunnel: boolean;
  agentEnabled: boolean;
  hermesHealthy: boolean;
}

export function routeTurn(ctx: RouterContext): RoutingDecision {
  if (ctx.hasActiveFunnel) {
    return { kind: 'scripted', reason: 'active funnel stage — deterministic path' };
  }

  if (ctx.agentEnabled && ctx.hermesHealthy) {
    return { kind: 'agentic', reason: 'non-scripted turn — hermes agent' };
  }

  if (ctx.agentEnabled && !ctx.hermesHealthy) {
    return { kind: 'fallback', reason: 'hermes unavailable — degraded to completion' };
  }

  return { kind: 'fallback', reason: 'agent not enabled — thin completion' };
}
