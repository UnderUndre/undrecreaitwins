import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { DocExtractionPipeline } from '../../../src/services/tuning/doc-extraction-pipeline.js';
import { LLMClient } from '../../../src/services/llm-client.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { groundingEngine } from '../../../src/services/index.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants, tuningDrafts } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// T013: Integration test verifying doc-extraction tuning finishes with zero
// embedding calls in big-context mode, and uses the embedding pipeline in
// vector mode (regression).
// ---------------------------------------------------------------------------
describe('T013 — Doc-extraction pipeline grounding-mode dispatch', () => {
  let pipeline: DocExtractionPipeline;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const personaId = '00000000-0000-0000-0000-000000000002';
  const draftId = '00000000-0000-0000-0000-000000000003';

  const docIds = [
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000012',
  ];

  const DOC_TEXTS = [
    'This is the first training document. It describes the brand voice as friendly and professional.',
    'The second document covers common objections and how the sales team should respond.',
    'Third document contains examples of successful email templates used in outreach campaigns.',
  ];

  const CHUNK_TEXTS = [
    'Chunked content from the vector pipeline for regression testing.',
  ];

  beforeEach(async () => {
    // Clean all relevant tables
    await db.delete(tuningDrafts);
    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    // Seed tenant (default groundingMode = 'vector')
    await db.insert(tenants).values({ id: tenantId });

    pipeline = new DocExtractionPipeline();

    // Mock LLM client so the pipeline never hits a real provider
    vi.spyOn(LLMClient.prototype, 'complete').mockResolvedValue({
      content: JSON.stringify({
        systemPrompt: 'You are a friendly and professional sales assistant.',
        funnelStages: [],
        validatorToggles: { profanity_check: true },
        confidence: 'high',
      }),
      model: 'gpt-4o',
      finishReason: 'stop',
      usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Scenario 1: Big-context mode extracts full text, zero embeddings
  // -----------------------------------------------------------------------
  it('big-context mode extracts full document text with zero embedding calls', async () => {
    // Setup persona with big-context grounding mode
    await db.insert(personas).values({
      id: personaId,
      tenantId,
      name: 'Big-context twin',
      slug: 'bc-twin',
      systemPrompt: 'You are a big-context twin',
      groundingMode: 'big-context',
    });

    // Insert 3 documents with known fullText
    for (let i = 0; i < DOC_TEXTS.length; i++) {
      await db.insert(documents).values({
        id: docIds[i],
        tenantId,
        personaId,
        filename: `doc-${i + 1}.txt`,
        mimeType: 'text/plain',
        sizeBytes: DOC_TEXTS[i].length,
        status: 'ready',
        fullText: DOC_TEXTS[i],
        priority: 0,
      });
    }

    // Insert a tuning draft with known ID (status 'generating' as pipeline expects)
    await db.insert(tuningDrafts).values({
      id: draftId,
      tenantId,
      personaId,
      method: 'doc-extraction',
      status: 'generating',
    });

    // Spy on embedding service to prove it was never called
    const embedSpy = vi.spyOn(EmbeddingService.prototype, 'embed');
    const rerankSpy = vi.spyOn(EmbeddingService.prototype, 'rerank');

    // Run the pipeline
    await pipeline.run(draftId, tenantId, personaId);

    // Verify embed/rerank were never called
    expect(embedSpy).not.toHaveBeenCalled();
    expect(rerankSpy).not.toHaveBeenCalled();

    // Verify no document_chunks rows exist for this persona
    const chunkRows = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.personaId, personaId));
    expect(chunkRows).toHaveLength(0);

    // Verify draft was updated to 'ready' with our mock's systemPrompt
    const draft = await db
      .select()
      .from(tuningDrafts)
      .where(eq(tuningDrafts.id, draftId))
      .then((rows) => rows[0]);

    expect(draft).toBeDefined();
    expect(draft.status).toBe('ready');
    expect(draft.systemPrompt).toBe('You are a friendly and professional sales assistant.');
    expect(draft.confidence).toBe('high');
    expect(draft.error).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Vector mode still uses the embedding pipeline (regression)
  // -----------------------------------------------------------------------
  it('vector mode reads from document_chunks via grounding engine', async () => {
    // Setup persona with default grounding mode (none set — inherits 'vector' from tenant)
    await db.insert(personas).values({
      id: personaId,
      tenantId,
      name: 'Vector twin',
      slug: 'vec-twin',
      systemPrompt: 'You are a vector twin',
    });

    // Insert a document
    const docId = docIds[0];
    await db.insert(documents).values({
      id: docId,
      tenantId,
      personaId,
      filename: 'vec-doc.txt',
      mimeType: 'text/plain',
      sizeBytes: DOC_TEXTS[0].length,
      status: 'ready',
      fullText: DOC_TEXTS[0],
      priority: 0,
    });

    // Insert a chunk (simulating what the DocumentWorker would produce)
    await db.insert(documentChunks).values({
      id: '00000000-0000-0000-0000-000000000020',
      tenantId,
      documentId: docId,
      personaId,
      chunkIndex: 0,
      text: CHUNK_TEXTS[0],
      embedding: new Array(1024).fill(0.1) as unknown as number[],
    });

    // Insert a tuning draft
    await db.insert(tuningDrafts).values({
      id: draftId,
      tenantId,
      personaId,
      method: 'doc-extraction',
      status: 'generating',
    });

    // Spy on groundingEngine.query to verify the vector path was taken
    const querySpy = vi.spyOn(groundingEngine, 'query');

    // Run the pipeline
    await pipeline.run(draftId, tenantId, personaId);

    // Verify groundingEngine.query was called (the vector/embedding pipeline)
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledWith('', tenantId, personaId);

    // Verify draft completed successfully
    const draft = await db
      .select()
      .from(tuningDrafts)
      .where(eq(tuningDrafts.id, draftId))
      .then((rows) => rows[0]);

    expect(draft).toBeDefined();
    expect(draft.status).toBe('ready');
    expect(draft.confidence).toBe('high');
    expect(draft.error).toBeNull();

    querySpy.mockRestore();
  });
});
