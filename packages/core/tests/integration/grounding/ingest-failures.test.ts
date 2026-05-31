import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';

describe('GroundingEngine Ingest Failures', () => {
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

  it('should handle parse failure gracefully', async () => {
    // Mock officeparser to fail
    vi.mock('officeparser', () => ({
      default: {
        parseOffice: (_buf: any, cb: any) => cb(null, new Error('Parse error'))
      }
    }));

    const content = Buffer.from('Broken doc');
    const { documentId } = await groundingEngine.ingest(
      content, 
      { filename: 'fail.txt', mimeType: 'text/plain', sizeBytes: content.length },
      tenantId,
      twinId
    );

    // Wait for failure
    for (let i = 0; i < 10; i++) {
      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (doc?.status === 'failed') break;
      await new Promise(r => setTimeout(resolve => r(resolve), 500));
    }

    const finalDoc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
    expect(finalDoc?.status).toBe('failed');
    expect(finalDoc?.error).toBeDefined();

    // Ensure no chunks were created
    const chunks = await db.select().from(documentChunks).where(eq(documentChunks.documentId, documentId));
    expect(chunks).toHaveLength(0);
  });
});
