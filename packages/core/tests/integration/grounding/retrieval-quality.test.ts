import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';

describe('GroundingEngine Retrieval Quality', () => {
  let groundingEngine: GroundingEngine;
  let embeddingService: EmbeddingService;
  let documentService: DocumentService;
  let documentWorker: DocumentWorker;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const twinId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    embeddingService = new EmbeddingService();
    documentService = new DocumentService();
    documentWorker = new DocumentWorker(embeddingService);
    groundingEngine = new GroundingEngine(embeddingService, documentService);

    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    await db.insert(tenants).values({ id: tenantId, name: 'T1', slug: 't1' });
    await db.insert(personas).values({ id: twinId, tenantId, name: 'P1', slug: 'p1', systemPrompt: 'S1' });
  });

  afterAll(async () => {
    await documentWorker.close();
  });

  it('should return [] for query with no relevant context below threshold', async () => {
    // 1. Ingest document
    const content = Buffer.from('Relevant data');
    const { documentId } = await groundingEngine.ingest(content, { filename: 't.txt', mimeType: 'text/plain', sizeBytes: content.length }, tenantId, twinId);
    
    // Mock worker and ready status
    vi.spyOn(embeddingService, 'embed').mockResolvedValue(new Array(1024).fill(0.1));
    await db.update(documents).set({ status: 'ready' }).where(eq(documents.id, documentId));
    await db.insert(documentChunks).values({
      tenantId,
      documentId,
      personaId: twinId,
      chunkIndex: 0,
      text: 'Relevant data',
      embedding: new Array(1024).fill(0.1)
    });

    // 2. Mock low rerank score
    vi.spyOn(embeddingService, 'rerank').mockResolvedValue([{ index: 0, score: 0.1 }]); // Below 0.3 threshold

    const results = await groundingEngine.query('Random query', tenantId, twinId);
    expect(results).toHaveLength(0);
  });

  it('should fallback to vector-only order if reranker is down', async () => {
    // 1. Ingest document
    const content = Buffer.from('Relevant data');
    const { documentId } = await groundingEngine.ingest(content, { filename: 't.txt', mimeType: 'text/plain', sizeBytes: content.length }, tenantId, twinId);
    
    await db.update(documents).set({ status: 'ready' }).where(eq(documents.id, documentId));
    await db.insert(documentChunks).values({
      tenantId,
      documentId,
      personaId: twinId,
      chunkIndex: 0,
      text: 'Relevant data',
      embedding: new Array(1024).fill(0.1)
    });

    // 2. Mock reranker failure
    vi.spyOn(embeddingService, 'rerank').mockRejectedValue(new Error('Reranker down'));

    const results = await groundingEngine.query('Some query', tenantId, twinId);
    
    // Should return results despite reranker failure (fallback to vector top-K)
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('Relevant data');
    expect(results[0].score).toBe(1.0); // Fallback score
  });
});
