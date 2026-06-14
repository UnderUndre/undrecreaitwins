import { eq, sql, and } from 'drizzle-orm';
import { withTenantContext } from '../../db.js';
import { feedbackMemories } from '../../models/feedback-memories.js';
import { embeddingService } from '../index.js';
import type { FeedbackMemory } from './types.js';

const SIMILARITY_THRESHOLD = parseFloat(process.env.FEEDBACK_SIMILARITY_THRESHOLD || '0.75');
const TOP_K = parseInt(process.env.FEEDBACK_TOP_K || '3', 10);
const HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;

function computeRecencyDecay(createdAt: Date): number {
  const ageMs = Date.now() - createdAt.getTime();
  return Math.exp(-ageMs / HALFLIFE_MS);
}

function getOperatorRoleWeight(role: string | null): number {
  switch (role) {
    case 'owner': return 1.5;
    case 'admin': return 1.2;
    default: return 1.0;
  }
}

export interface RetrievalResult {
  memories: FeedbackMemory[];
  similarityScores: Array<{ memoryId: string; score: number }>;
  latencyMs: number;
}

export async function retrieveRelevant(
  tenantId: string,
  personaId: string,
  queryText: string,
  conversationState: { appliedFeedbackIds: string[] },
  existingEmbedding?: number[],
): Promise<RetrievalResult> {
  const start = Date.now();

  try {
    // Empty-set check (FR-009)
    const hasActive = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .select({ id: feedbackMemories.id })
        .from(feedbackMemories)
        .where(and(
          eq(feedbackMemories.tenantId, tenantId),
          eq(feedbackMemories.personaId, personaId),
          eq(feedbackMemories.status, 'active'),
        ))
        .limit(1);
      return rows.length > 0;
    });

    if (!hasActive) {
      return { memories: [], similarityScores: [], latencyMs: Date.now() - start };
    }

    // Reuse RAG embedding or embed fresh
    const queryEmbedding = existingEmbedding ?? await embeddingService.embed(queryText);
    const embeddingStr = JSON.stringify(queryEmbedding);

    // pgvector cosine search — explicitly select cosine distance for scoring
    const candidates = await withTenantContext(tenantId, async (tx) => {
      const distanceExpr = sql`(${feedbackMemories.contextEmbedding} <=> ${embeddingStr}::vector)`.as('cosine_dist');
      return tx
        .select({
          id: feedbackMemories.id,
          tenantId: feedbackMemories.tenantId,
          personaId: feedbackMemories.personaId,
          contextEmbedding: feedbackMemories.contextEmbedding,
          lesson: feedbackMemories.lesson,
          status: feedbackMemories.status,
          operatorRole: feedbackMemories.operatorRole,
          weight: feedbackMemories.weight,
          sourceConversationId: feedbackMemories.sourceConversationId,
          createdAt: feedbackMemories.createdAt,
          updatedAt: feedbackMemories.updatedAt,
          cosineDist: distanceExpr,
        })
        .from(feedbackMemories)
        .where(and(
          eq(feedbackMemories.tenantId, tenantId),
          eq(feedbackMemories.personaId, personaId),
          eq(feedbackMemories.status, 'active'),
          sql`1 - (${feedbackMemories.contextEmbedding} <=> ${embeddingStr}::vector) >= ${SIMILARITY_THRESHOLD}`,
        ))
        .orderBy(sql`${feedbackMemories.contextEmbedding} <=> ${embeddingStr}::vector`)
        .limit(TOP_K * 2);
    });

    // Dedup + score
    const scored = candidates
      .filter(r => !conversationState.appliedFeedbackIds.includes(r.id))
      .map(r => {
        const cosineDist = (r as any).cosineDist ?? 0;
        const similarity = 1 - cosineDist;
        const recency = computeRecencyDecay(r.createdAt);
        const roleWeight = getOperatorRoleWeight(r.operatorRole);
        const score = similarity * (r.weight ?? 1.0) * recency * roleWeight;
        return { memory: r as FeedbackMemory, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);

    return {
      memories: scored.map(s => s.memory),
      similarityScores: scored.map(s => ({ memoryId: s.memory.id, score: s.score })),
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    console.warn({ err }, '[FeedbackRetrieval] Failed, returning empty (graceful degradation)');
    return { memories: [], similarityScores: [], latencyMs: Date.now() - start };
  }
}
