import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';

describe('GroundingEngine Tenant Isolation', () => {
  let groundingEngine: GroundingEngine;
  let embeddingService: EmbeddingService;
  let documentService: DocumentService;
  let documentWorker: DocumentWorker;

  const tenantA = '00000000-0000-0000-0000-00000000000a';
  const tenantB = '00000000-0000-0000-0000-00000000000b';
  const twinA = '00000000-0000-0000-0000-000000000001';
  const twinB = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    embeddingService = new EmbeddingService();
    documentService = new DocumentService();
    documentWorker = new DocumentWorker(embeddingService);
    groundingEngine = new GroundingEngine(embeddingService, documentService);

    vi.spyOn(embeddingService, 'embed').mockResolvedValue(new Array(1024).fill(0.1));
    vi.spyOn(embeddingService, 'rerank').mockResolvedValue([{ index: 0, score: 0.9 }]);

    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    await db.insert(tenants).values([
      { id: tenantA, name: 'Tenant A', slug: 'a' },
      { id: tenantB, name: 'Tenant B', slug: 'b' }
    ]);
    await db.insert(personas).values([
      { id: twinA, tenantId: tenantA, name: 'Twin A', slug: 'a', systemPrompt: 'A' },
      { id: twinB, tenantId: tenantB, name: 'Twin B', slug: 'b', systemPrompt: 'B' }
    ]);
  });

  afterAll(async () => {
    await documentWorker.close();
  });

  it('should not allow tenant B to retrieve tenant A documents', async () => {
    // 1. Tenant A ingests
    const content = Buffer.from('Secret data for A');
    const { documentId } = await groundingEngine.ingest(
      content, 
      { filename: 'a.txt', mimeType: 'text/plain', sizeBytes: content.length },
      tenantA,
      twinA
    );

    // Wait for ready
    for (let i = 0; i < 10; i++) {
      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (doc?.status === 'ready') break;
      await new Promise(r => setTimeout(resolve => r(resolve), 500));
    }

    // 2. Tenant B queries
    const results = await groundingEngine.query('Secret data', tenantB, twinB);
    expect(results).toHaveLength(0);

    // 3. Tenant A queries
    const resultsA = await groundingEngine.query('Secret data', tenantA, twinA);
    expect(resultsA).toHaveLength(1);
  });
});
