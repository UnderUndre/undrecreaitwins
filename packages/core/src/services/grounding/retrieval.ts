import { sql } from 'drizzle-orm';
import { withTenantContext } from '../../db.js';
import { documentChunks, documents } from '../../models/documents.js';
import { EmbeddingService } from '../embedding-service.js';
import { GroundingContext, DocumentContext } from '../../interfaces/IGroundingEngine.js';
import pino from 'pino';

const logger = pino({ name: 'retrieval' });

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

export async function countTokens(text: string): Promise<number> {
  const omniRouteUrl = process.env.OMNIROUTE_URL || process.env.LLM_PROVIDER_URL;
  if (omniRouteUrl) {
    try {
      const response = await fetch(`${omniRouteUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: text }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json() as { input_tokens: number };
        if (typeof data.input_tokens === 'number') {
          return data.input_tokens;
        }
      }
      logger.warn({ status: response.status }, 'OmniRoute count_tokens failed, falling back to tiktoken');
    } catch (err) {
      logger.warn({ err }, 'OmniRoute count_tokens error, falling back to tiktoken');
    }
  }

  try {
    const { getEncoding } = await import('js-tiktoken');
    const encoding = getEncoding('cl100k_base');
    const tokens = encoding.encode(text);
    return tokens.length;
  } catch (err) {
    logger.warn({ err }, 'js-tiktoken failed, falling back to chars/4 estimate');
  }

  const estimated = Math.ceil(text.length / 4);
  logger.warn({ textLength: text.length, estimatedTokens: estimated }, 'chars/4 fallback used for token counting');
  return estimated;
}

export interface TruncationOptions {
  contextBudgetTokens: number;
  safetyMargin?: number;
}

export async function truncateDocuments(
  documents: DocumentContext[],
  options: TruncationOptions
): Promise<{
  kept: DocumentContext[];
  dropped: DocumentContext[];
  keptTokens: number;
  totalBudget: number;
}> {
  const safetyMargin = options.safetyMargin ?? 0.05;
  const totalBudget = Math.floor(options.contextBudgetTokens * (1 - safetyMargin));

  const kept: DocumentContext[] = [];
  const dropped: DocumentContext[] = [];
  let keptTokens = 0;

  const docTokensList = await Promise.all(documents.map(doc => countTokens(doc.text)));

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]!;
    const docTokens = docTokensList[i]!;
    if (keptTokens + docTokens > totalBudget && kept.length > 0) {
      dropped.push(...documents.slice(i));
      break;
    }
    kept.push(doc);
    keptTokens += docTokens;
  }

  return { kept, dropped, keptTokens, totalBudget };
}

export async function retrieveBigContext(
  tenantId: string,
  personaId: string,
  options?: { contextBudgetTokens?: number },
): Promise<DocumentContext[]> {
  const contextBudgetTokens = options?.contextBudgetTokens ?? (Number(process.env.BIG_CONTEXT_MAX_TOKENS) || 8000);

  const rows = await withTenantContext(tenantId, async (tx) => {
    return tx
      .select({
        id: documents.id,
        fullText: documents.fullText,
        filename: documents.filename,
        priority: documents.priority,
      })
      .from(documents)
      .where(
        sql`${documents.personaId} = ${personaId} AND ${documents.fullText} IS NOT NULL`
      )
      .orderBy(sql`${documents.priority} DESC`, sql`${documents.createdAt} DESC`);
  });

  if (rows.length === 0) {
    logger.info({ tenantId, personaId }, 'No big-context documents found');
    return [];
  }

  const docs: DocumentContext[] = rows.map(r => ({
    text: r.fullText!,
    score: 1.0,
    metadata: {
      documentId: r.id,
      priority: r.priority,
    },
    filename: r.filename,
  }));

  const result = await truncateDocuments(docs, { contextBudgetTokens });

  const totalDocs = result.kept.length + result.dropped.length;
  logger.warn({
    tenantId,
    personaId,
    keptCount: result.kept.length,
    droppedCount: result.dropped.length,
    keptTokens: result.keptTokens,
    budgetTokens: result.totalBudget,
  }, `Big-context truncation: kept ${result.kept.length}/${totalDocs} docs, ${result.keptTokens}/${result.totalBudget} tokens`);

  return result.kept;
}
