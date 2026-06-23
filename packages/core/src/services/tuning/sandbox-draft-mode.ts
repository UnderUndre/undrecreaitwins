import type { DraftConfigOverlay } from '../../types/tuning.js';

export interface ShadowPersona {
  systemPrompt: string;
  traits?: Record<string, unknown>;
  funnelConfig?: unknown;
  validatorToggles?: Record<string, boolean>;
}

export function createShadowPersona(
  persona: { systemPrompt: string; traits?: Record<string, unknown> },
  overlay: DraftConfigOverlay,
): ShadowPersona {
  return {
    systemPrompt: overlay.systemPrompt ?? persona.systemPrompt,
    traits: persona.traits,
    funnelConfig: overlay.funnelConfig,
    validatorToggles: overlay.validatorToggles,
  };
}
