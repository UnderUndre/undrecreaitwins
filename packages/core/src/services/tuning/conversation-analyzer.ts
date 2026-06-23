import { randomUUID } from 'node:crypto';
import { redisHelper } from './redis-helper.js';
import { TuningDraftRepository } from './tuning-draft-repository.js';
import type { TuningProposal } from '../../types/tuning.js';

export class ConversationAnalyzer {
  async analyze(tenantId: string, personaId: string): Promise<{
    proposals: TuningProposal[];
    warmup: boolean;
  }> {
    // Check warm-up threshold
    // In v1, use a simplified approach — if no previous drafts exist, mark as warmup
    const draftRepo = new TuningDraftRepository();
    const drafts = await draftRepo.listByPersona(tenantId, personaId);

    if (drafts.length < 3) {
      // Very few drafts — suggest user interacts more
      return {
        proposals: [],
        warmup: true,
      };
    }

    // Generate proposals based on failed drafts
    const proposals: TuningProposal[] = [];
    const failedDrafts = drafts.filter(d => d.status === 'failed');

    if (failedDrafts.length > 2) {
      proposals.push({
        id: randomUUID(),
        personaId,
        signal: 'validation_failures',
        description: `${failedDrafts.length} drafts have failed generation. Consider reviewing documents or interview answers.`,
        riskLevel: 'medium',
        affectedConversations: failedDrafts.length,
        suggestedAction: 'Review document quality and try generating again with clearer documents.',
        createdAt: new Date().toISOString(),
      });
    }

    // Look for repeated patterns in draft errors
    const errorCounts: Record<string, number> = {};
    for (const d of failedDrafts) {
      if (d.error) {
        errorCounts[d.error] = (errorCounts[d.error] || 0) + 1;
      }
    }

    for (const [error, count] of Object.entries(errorCounts)) {
      if (count >= 2) {
        proposals.push({
          id: randomUUID(),
          personaId,
          signal: 'repeated_topic',
          description: `Recurring error "${error}" occurred ${count} times`,
          riskLevel: count > 3 ? 'high' : 'medium',
          affectedConversations: count,
          suggestedAction: `Address the recurring issue: ${error}`,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Cache proposals
    await redisHelper.set(redisHelper.proposalsKey(tenantId, personaId), proposals, 1800);

    return { proposals, warmup: false };
  }

  async getCachedProposals(tenantId: string, personaId: string): Promise<TuningProposal[] | null> {
    return redisHelper.get<TuningProposal[]>(redisHelper.proposalsKey(tenantId, personaId));
  }

  async acceptProposal(tenantId: string, personaId: string, proposalId: string): Promise<{ draftId: string } | null> {
    const key = redisHelper.proposalsKey(tenantId, personaId);
    const proposals = await redisHelper.get<TuningProposal[]>(key);
    if (!proposals) return null;

    const proposal = proposals.find(p => p.id === proposalId);
    if (!proposal) return null;

    // Remove from cached array
    const filtered = proposals.filter(p => p.id !== proposalId);
    await redisHelper.set(key, filtered, 1800);

    // Create draft
    const draftRepo = new TuningDraftRepository();
    const draft = await draftRepo.create(tenantId, {
      personaId,
      method: 'self-tuner',
      signals: [proposal] as any,
    });
    await draftRepo.update(tenantId, draft.id, { status: 'ready' });

    return { draftId: draft.id };
  }

  async rejectProposal(tenantId: string, personaId: string, proposalId: string): Promise<void> {
    await redisHelper.updateArray<TuningProposal>(
      redisHelper.proposalsKey(tenantId, personaId),
      (p) => p.id === proposalId,
    );
  }
}
