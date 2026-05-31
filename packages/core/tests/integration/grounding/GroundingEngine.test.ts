import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';

describe('GroundingEngine Integration', () => {
  let groundingEngine: GroundingEngine;
  let embeddingService: EmbeddingService;
  let documentService: DocumentService;
  let documentWorker: DocumentWorker;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const twinId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    // Setup services
    embeddingService = new EmbeddingService();
    documentService = new DocumentService();
    documentWorker = new DocumentWorker(embeddingService);
    groundingEngine = new GroundingEngine(embeddingService, documentService);

    // Mock Embedding Service calls
    vi.spyOn(embeddingService, 'embed').mockResolvedValue(new Array(1024).fill(0.1));
    vi.spyOn(embeddingService, 'rerank').mockResolvedValue([
      { index: 0, score: 0.95 },
      { index: 1, score: 0.85 }
    ]);

    // Cleanup DB
    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    // Seed tenant and persona
    await db.insert(tenants).values({ id: tenantId, name: 'Test Tenant', slug: 'test' });
    await db.insert(personas).values({ 
        id: twinId, 
        tenantId, 
        name: 'Test Twin', 
        slug: 'test-twin', 
        systemPrompt: 'You are a test twin' 
    });
  });

  afterAll(async () => {
    await documentWorker.close();
  });

  it('should ingest a document and retrieve grounded context', async () => {
    const content = Buffer.from('This is a test document content about facts.');
    const meta = {
      filename: 'test.txt',
      mimeType: 'text/plain' as const,
      sizeBytes: content.length,
    };

    // 1. Ingest
    const { documentId, status } = await groundingEngine.ingest(content, meta, tenantId, twinId);
    expect(documentId).toBeDefined();
    expect(status).toBe('pending');

    // 2. Wait for worker to process (Polling)
    let currentStatus = status;
    for (let i = 0; i < 10; i++) {
        const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
        currentStatus = doc?.status || 'failed';
        if (currentStatus === 'ready' || currentStatus === 'failed') break;
        await new Promise(r => setTimeout(resolve => r(resolve), 500));
    }

    expect(currentStatus).toBe('ready');

    // 3. Query
    const results = await groundingEngine.query('What are the facts?', tenantId, twinId);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('test document content');
    expect(results[0].score).toBe(0.95);
  });
});
