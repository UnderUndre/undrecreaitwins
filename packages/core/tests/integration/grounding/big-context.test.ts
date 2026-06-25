import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { ChatService } from '../../../src/services/chat-service.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';
import { groundingEngine } from '../../../src/services/index.js';
import type { DocumentContext, GroundingContext } from '../../../src/interfaces/IGroundingEngine.js';

// ---------------------------------------------------------------------------
// GroundingEngine-level tests: big-context vs vector retrieval, isolation,
// NULL fullText exclusion.
// ---------------------------------------------------------------------------
describe('GroundingEngine — big-context mode', () => {
  let engine: GroundingEngine;
  let embeddingService: EmbeddingService;
  let documentService: DocumentService;
  let documentWorker: DocumentWorker;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const twinId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    embeddingService = new EmbeddingService();
    documentService = new DocumentService();
    documentWorker = new DocumentWorker(embeddingService);
    engine = new GroundingEngine(embeddingService, documentService);

    vi.spyOn(embeddingService, 'embed').mockResolvedValue(new Array(1024).fill(0.1));
    vi.spyOn(embeddingService, 'rerank').mockResolvedValue([{ index: 0, score: 0.9 }]);

    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    await db.insert(tenants).values({ id: tenantId, name: 'T1', slug: 't1' });
  });

  afterAll(async () => {
    await documentWorker.close();
  });

  // -----------------------------------------------------------------------
  // T011 — Scenario 1: Big-context mode returns full documents
  // -----------------------------------------------------------------------
  it('returns DocumentContext[] with full document text, score 1.0, no chunkIndex', async () => {
    await db.insert(personas).values({
      id: twinId,
      tenantId,
      name: 'Big-context twin',
      slug: 'bc-twin',
      systemPrompt: 'You are a big-context twin',
      groundingMode: 'big-context',
    });

    const docId = '00000000-0000-0000-0000-000000000010';
    const fullText = 'This is the complete document text. It covers all the important topics.';
    await db.insert(documents).values({
      id: docId,
      tenantId,
      personaId: twinId,
      filename: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: fullText.length,
      status: 'ready',
      fullText,
      priority: 0,
    });

    const results = await engine.query('irrelevant query', tenantId, twinId);

    expect(results).toHaveLength(1);
    const doc = results[0] as DocumentContext;
    expect(doc.text).toBe(fullText);
    expect(doc.score).toBe(1.0);
    expect(doc.metadata).not.toHaveProperty('chunkIndex');
    expect(doc.metadata.documentId).toBe(docId);
    expect(doc.filename).toBe('report.txt');
  });

  // -----------------------------------------------------------------------
  // T011 — Scenario 2: Vector mode unchanged (returns GroundingContext[])
  // -----------------------------------------------------------------------
  it('vector mode returns GroundingContext[] with chunkIndex', async () => {
    await db.insert(personas).values({
      id: twinId,
      tenantId,
      name: 'Vector twin',
      slug: 'vec-twin',
      systemPrompt: 'You are a vector twin',
    });

    const content = Buffer.from('Chunked document content for vector retrieval');
    const { documentId } = await engine.ingest(
      content,
      { filename: 'vec.txt', mimeType: 'text/plain', sizeBytes: content.length },
      tenantId,
      twinId,
    );
    await db.update(documents).set({ status: 'ready' }).where(eq(documents.id, documentId));
    await db.insert(documentChunks).values({
      tenantId,
      documentId,
      personaId: twinId,
      chunkIndex: 0,
      text: 'Chunked document content for vector retrieval',
      embedding: new Array(1024).fill(0.1),
    });

    const results = await engine.query('vector query', tenantId, twinId);

    expect(results).toHaveLength(1);
    const ctx = results[0] as GroundingContext;
    expect(ctx.metadata.chunkIndex).toBe(0);
    expect(ctx.text).toContain('Chunked document content');
  });

  // -----------------------------------------------------------------------
  // T011 — Scenario 3: Tenant isolation
  // -----------------------------------------------------------------------
  it('enforces tenant isolation — each tenant sees only its own documents', async () => {
    const tenantA = '00000000-0000-0000-0000-00000000000a';
    const tenantB = '00000000-0000-0000-0000-00000000000b';
    const twinA = '00000000-0000-0000-0000-0000000000a1';
    const twinB = '00000000-0000-0000-0000-0000000000b1';

    await db.insert(tenants).values([
      { id: tenantA, name: 'Tenant A', slug: 'a' },
      { id: tenantB, name: 'Tenant B', slug: 'b' },
    ]);
    await db.insert(personas).values([
      { id: twinA, tenantId: tenantA, name: 'Twin A', slug: 'twin', systemPrompt: 'A', groundingMode: 'big-context' },
      { id: twinB, tenantId: tenantB, name: 'Twin B', slug: 'twin', systemPrompt: 'B', groundingMode: 'big-context' },
    ]);

    const docA = '00000000-0000-0000-0000-0000000000a1';
    const docB = '00000000-0000-0000-0000-0000000000b1';
    await db.insert(documents).values([
      { id: docA, tenantId: tenantA, personaId: twinA, filename: 'a-secret.txt', mimeType: 'text/plain', sizeBytes: 12, status: 'ready', fullText: 'Secret data for A', priority: 0 },
      { id: docB, tenantId: tenantB, personaId: twinB, filename: 'b-secret.txt', mimeType: 'text/plain', sizeBytes: 12, status: 'ready', fullText: 'Secret data for B', priority: 0 },
    ]);

    const resultsA = await engine.query('secret', tenantA, twinA);
    expect(resultsA).toHaveLength(1);
    expect((resultsA[0] as DocumentContext).filename).toBe('a-secret.txt');

    const resultsB = await engine.query('secret', tenantB, twinB);
    expect(resultsB).toHaveLength(1);
    expect((resultsB[0] as DocumentContext).filename).toBe('b-secret.txt');
  });

  // -----------------------------------------------------------------------
  // T011 — Scenario 5: NULL fullText handling
  // -----------------------------------------------------------------------
  it('excludes documents with NULL fullText from results', async () => {
    await db.insert(personas).values({
      id: twinId,
      tenantId,
      name: 'BC twin',
      slug: 'bc-twin',
      systemPrompt: 'You are a big-context twin',
      groundingMode: 'big-context',
    });

    // Document with extraction failure — fullText is NULL
    await db.insert(documents).values({
      id: '00000000-0000-0000-0000-0000000000null',
      tenantId,
      personaId: twinId,
      filename: 'failed-extract.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      status: 'failed',
      error: 'Extraction failed',
      fullText: null,
      priority: 0,
    });

    // Document that was processed successfully
    await db.insert(documents).values({
      id: '00000000-0000-0000-0000-0000000000good',
      tenantId,
      personaId: twinId,
      filename: 'good-doc.txt',
      mimeType: 'text/plain',
      sizeBytes: 18,
      status: 'ready',
      fullText: 'Good document content',
      priority: 0,
    });

    const results = await engine.query('test', tenantId, twinId);

    expect(results).toHaveLength(1);
    expect((results[0] as DocumentContext).filename).toBe('good-doc.txt');
  });
});

// ---------------------------------------------------------------------------
// ChatService-level test: prefix-stable <documents> block formatting (FR-011)
// ---------------------------------------------------------------------------
describe('ChatService.buildSystemPrompt — big-context prompt formatting (FR-011)', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const twinId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    await db.insert(tenants).values({ id: tenantId, name: 'T1', slug: 't1' });
    await db.insert(personas).values({
      id: twinId,
      tenantId,
      name: 'BC Twin',
      slug: 'bc-twin',
      systemPrompt: 'Base system prompt.',
      groundingMode: 'big-context',
    });
  });

  it('produces <documents> block with filename headers and full document text', async () => {
    const mockDocs: DocumentContext[] = [
      {
        text: 'Full content of the first uploaded document.',
        score: 1.0,
        metadata: { documentId: 'doc-1', priority: 0 },
        filename: 'guide.pdf',
      },
      {
        text: 'Content of the second document with more details.',
        score: 1.0,
        metadata: { documentId: 'doc-2', priority: 1 },
        filename: 'manual.docx',
      },
    ];

    const querySpy = vi.spyOn(groundingEngine, 'query').mockResolvedValue(mockDocs);
    const chatService = new ChatService();

    const persona = {
      id: twinId,
      tenantId,
      systemPrompt: 'Base system prompt.',
      ragMode: 'static' as const,
      traits: {},
      hasAnnotations: false,
      annotationSimilarityThreshold: 0.7,
      strictRag: false,
      strictRagRefusal: null,
      ragRelevanceThreshold: 0.3,
      feedbackRetrievalEnabled: false,
      feedbackTokenBudget: 500,
      funnelGeneration: 'single' as const,
    };

    const result = await (ChatService.prototype as any).buildSystemPrompt.call(
      chatService,
      tenantId,
      persona,
      'user query',
      undefined,
    );

    expect(result.prompt).toContain('<documents>');
    expect(result.prompt).toContain('[Document 1: guide.pdf]');
    expect(result.prompt).toContain('Full content of the first uploaded document.');
    expect(result.prompt).toContain('[Document 2: manual.docx]');
    expect(result.prompt).toContain('Content of the second document with more details.');
    expect(result.prompt).toContain('</documents>');

    const docsIndex = result.prompt.indexOf('<documents>');
    const baseIndex = result.prompt.indexOf('Base system prompt.');
    expect(docsIndex).toBeGreaterThan(baseIndex);

    querySpy.mockRestore();
  });
});
