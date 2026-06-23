export class FunnelConfigMapper {
  async mapToVersion(
    _tenantId: string,
    personaId: string,
    funnelConfig: { funnelStages?: Array<{ name: string; description: string; triggers?: string[]; slots?: Array<{ name: string; type: string; question: string }> }> } | null,
  ): Promise<{
    definitionId: string;
    stages: Array<{ name: string; description: string; fragments: string[] }>;
    slots: Array<{ name: string; type: string; question: string }>;
  } | null> {
    if (!funnelConfig?.funnelStages || funnelConfig.funnelStages.length === 0) {
      return null;
    }

    const definitionId = `tuning-${personaId.slice(0, 8)}`;

    const stages = funnelConfig.funnelStages.map(stage => ({
      name: stage.name,
      description: stage.description || '',
      fragments: [stage.description || stage.name],
    }));

    const slots = funnelConfig.funnelStages
      .flatMap(stage => stage.slots || [])
      .filter((slot, idx, arr) => arr.findIndex(s => s.name === slot.name) === idx)
      .map(slot => ({
        name: slot.name,
        type: slot.type || 'text',
        question: slot.question || `Please provide ${slot.name}`,
      }));

    return { definitionId, stages, slots };
  }
}
