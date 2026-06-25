import { sql } from 'drizzle-orm';
import { withTenantContext } from '../../db.js';
import { documentChunks } from '../../models/documents.js';
import { EmbeddingService } from '../embedding-service.js';

export interface GroundingContext {
  text: string;
  score: number;
  metadata: {
    documentId: string;
    chunkIndex: number;
  };
}

export interface RetrievalOptions {
  vectorTopK?: number;
  rerankTopN?: number;
  minRerankScore?: number;
  contextBudgetTokens?: number;
}

/**
 * Core retrieval logic: Vector Search (pgvector) + BGE-Reranker.
 * Enforces tenant isolation via withTenantContext.
 */
export async function retrieve(
  query: string,
  tenantId: string,
  personaId: string,
  embeddingService: EmbeddingService,
  options: RetrievalOptions = {}
): Promise<GroundingContext[]> {
  const {
    vectorTopK = 20,
    rerankTopN = 5,
    minRerankScore = 0.3,
    contextBudgetTokens = 2000
  } = options;

  // 1. Embed query (skip if empty — doc-extraction wants all chunks)
  if (!query || query.trim().length === 0) {
    const allChunks = await withTenantContext(tenantId, async (tx) => {
      return tx
        .select({
          id: documentChunks.id,
          text: documentChunks.text,
          documentId: documentChunks.documentId,
          chunkIndex: documentChunks.chunkIndex,
        })
        .from(documentChunks)
        .where(sql`${documentChunks.personaId} = ${personaId}`)
        .limit(vectorTopK);
    });

    if (allChunks.length === 0) return [];

    return allChunks.map(c => ({
      text: c.text,
      score: 1.0,
      metadata: {
        documentId: c.documentId,
        chunkIndex: c.chunkIndex,
      },
    }));
  }

  const queryEmbedding = await embeddingService.embed(query);
  const queryEmbeddingSql = JSON.stringify(queryEmbedding);

  // 2. Vector search (candidates)
  const candidates = await withTenantContext(tenantId, async (tx) => {
    return tx
      .select({
        id: documentChunks.id,
        text: documentChunks.text,
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
      })
      .from(documentChunks)
      .where(
        sql`${documentChunks.personaId} = ${personaId}`
      )
      .orderBy(sql`${documentChunks.embedding} <=> ${queryEmbeddingSql}::vector`)
      .limit(vectorTopK);
  });

  if (candidates.length === 0) return [];

  // 3. Rerank candidates
  const candidateTexts = candidates.map(c => c.text);
  let ranked: GroundingContext[];

  try {
    const rerankResults = await embeddingService.rerank(query, candidateTexts);

    // Map, filter by threshold, and sort by rerank score
    ranked = rerankResults
      .map(r => {
        const candidate = candidates[r.index];
        if (!candidate) return null;
        return {
          text: candidate.text,
          score: r.score,
          metadata: {
            documentId: candidate.documentId,
            chunkIndex: candidate.chunkIndex,
          }
        };
      })
      .filter((c): c is GroundingContext => c !== null && c.score >= minRerankScore)
      .sort((a, b) => b.score - a.score);

  } catch (err) {
    console.warn('[Retrieval] Reranker failed, falling back to vector-only results', err);
    // Fallback: use top candidates directly with a dummy high score (since threshold cannot be checked)
    // or just pass them through.
    ranked = candidates.map(c => ({
      text: c.text,
      score: 1.0, // dummy score for fallback
      metadata: {
        documentId: c.documentId,
        chunkIndex: c.chunkIndex,
      }
    }));
  }

  // 5. Pack into context budget (simple token approximation)
  const finalRanked = ranked.slice(0, rerankTopN);
  let currentTokens = 0;
  const packed: GroundingContext[] = [];

  for (const item of finalRanked) {
    const approxTokens = Math.ceil(item.text.length / 4);
    if (currentTokens + approxTokens > contextBudgetTokens && packed.length > 0) {
      break; 
    }
    packed.push(item);
    currentTokens += approxTokens;
  }

  return packed;
}
