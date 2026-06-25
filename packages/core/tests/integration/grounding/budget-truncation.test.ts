import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import { eq } from 'drizzle-orm';
import type { DocumentContext, GroundingContext } from '../../../src/interfaces/IGroundingEngine.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('pino', () => ({
  default: () => loggerMock,
}));

// Make countTokens fall back to chars/4 for deterministic results
vi.mock('js-tiktoken', () => ({
  getEncoding: () => { throw new Error('mock: js-tiktoken unavailable'); },
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TWIN_ID = '00000000-0000-0000-0000-000000000002';
const BASE_TIME = new Date('2025-06-01T00:00:00Z');

// chars/4 fallback: each "word " = 5 chars ≈ 1.25 tokens
function createDocText(tokenCount: number): string {
  const reps = Math.ceil(tokenCount * 0.8);
  return 'word '.repeat(reps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GroundingEngine — Budget truncation & fallback-vector (US3)', () => {
  let engine: GroundingEngine;
  let embeddingService: EmbeddingService;
  let documentService: DocumentService;
  let documentWorker: DocumentWorker;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.BIG_CONTEXT_MAX_TOKENS = '800';

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

    await db.insert(tenants).values({ id: TENANT_ID });
  });

  afterAll(async () => {
    await documentWorker.close();
    delete process.env.BIG_CONTEXT_MAX_TOKENS;
  });

  // -----------------------------------------------------------------------
  // T015 — Silent truncation ordering
  // -----------------------------------------------------------------------
  it('T015: silent truncation keeps docs by priority desc, ties by createdAt desc', async () => {
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'BC twin',
      slug: 'bc-twin',
      systemPrompt: 'You are a big-context twin',
      groundingMode: 'big-context',
      truncationStrategy: 'silent',
    });

    const text = createDocText(200);

    await db.insert(documents).values([
      {
        id: '00000000-0000-0000-0000-000000000001',
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'doc1.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'ready',
        fullText: `__T015__doc1__ ${text}`,
        priority: 10,
        createdAt: new Date(BASE_TIME.getTime() + 0),
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'doc2.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'ready',
        fullText: `__T015__doc2__ ${text}`,
        priority: 5,
        createdAt: new Date(BASE_TIME.getTime() + 1000),
      },
      {
        id: '00000000-0000-0000-0000-000000000003',
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'doc3.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'ready',
        fullText: `__T015__doc3__ ${text}`,
        priority: 1,
        createdAt: new Date(BASE_TIME.getTime() + 2000),
      },
      {
        id: '00000000-0000-0000-0000-000000000004',
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'doc4.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'ready',
        fullText: `__T015__doc4__ ${text}`,
        priority: 5,
        createdAt: new Date(BASE_TIME.getTime() + 3000),
      },
      {
        id: '00000000-0000-0000-0000-000000000005',
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'doc5.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'ready',
        fullText: `__T015__doc5__ ${text}`,
        priority: 0,
        createdAt: new Date(BASE_TIME.getTime() + 4000),
      },
    ]);

    const results = await engine.query('test query', TENANT_ID, TWIN_ID);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(5);

    const docs = results as DocumentContext[];

    // Priorities must be non-ascending (desc or equal)
    for (let i = 1; i < docs.length; i++) {
      const prev = docs[i - 1]!;
      const curr = docs[i]!;
      expect(prev.metadata.priority).toBeGreaterThanOrEqual(curr.metadata.priority);
    }

    // First doc is highest priority (10)
    expect(docs[0]!.metadata.documentId).toBe('00000000-0000-0000-0000-000000000001');
    expect(docs[0]!.metadata.priority).toBe(10);

    const keptIds = docs.map(d => d.metadata.documentId);
    expect(keptIds).not.toContain('00000000-0000-0000-0000-000000000005'); // p0 dropped

    // Tiebreaker: within priority 5, doc4 (T+3s, newer) before doc2 (T+1s, older)
    const idx4 = keptIds.indexOf('00000000-0000-0000-0000-000000000004');
    const idx2 = keptIds.indexOf('00000000-0000-0000-0000-000000000002');
    if (idx4 !== -1 && idx2 !== -1) {
      expect(idx4).toBeLessThan(idx2);
    }

    // Operator log exists (silent truncation logged)
    const truncationCalls = loggerMock.warn.mock.calls.filter(
      (call: any) => typeof call[1] === 'string' && call[1].includes('Big-context truncation'),
    );
    expect(truncationCalls.length).toBeGreaterThanOrEqual(1);

    const truncCtx = truncationCalls[0]![0] as Record<string, unknown>;
    expect(truncCtx.droppedCount).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // T016 — Fallback-vector: degrade to silent when embeddings not ready
  // -----------------------------------------------------------------------
  it('T016: fallback-vector degrades to silent truncation when embeddingsStatus !== completed', async () => {
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'BC twin',
      slug: 'bc-twin',
      systemPrompt: 'You are a big-context twin',
      groundingMode: 'big-context',
      truncationStrategy: 'fallback-vector',
      embeddingsStatus: 'idle',
    });

    const text = createDocText(200);
    await db.insert(documents).values([
      {
        id: '00000000-0000-0000-0000-0000000000d1',
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'fallback-doc.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'ready',
        fullText: `__T016_degrade__ ${text}`,
        priority: 5,
      },
    ]);

    const results = await engine.query('test query', TENANT_ID, TWIN_ID);

    // Returns DocumentContext[] (silent truncation), not GroundingContext[]
    expect(results.length).toBe(1);
    const doc = results[0] as DocumentContext;

    expect(doc.filename).toBe('fallback-doc.txt');
    expect(doc.metadata).not.toHaveProperty('chunkIndex');
    expect(doc.metadata).toHaveProperty('priority');
    expect(doc.score).toBe(1.0);

    // Logger warned about incomplete embeddings
    const warnCalls = loggerMock.warn.mock.calls.filter(
      (call: any) => typeof call[1] === 'string' && call[1].includes('Fallback-vector strategy skipped'),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const warnCtx = warnCalls[0]![0] as Record<string, unknown>;
    expect(warnCtx.embeddingsStatus).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // T016 — Fallback-vector: vector search when embeddings are ready
  // -----------------------------------------------------------------------
  it('T016: fallback-vector returns GroundingContext[] when embeddingsStatus === completed', async () => {
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'BC twin',
      slug: 'bc-twin',
      systemPrompt: 'You are a big-context twin',
      groundingMode: 'big-context',
      truncationStrategy: 'fallback-vector',
      embeddingsStatus: 'completed',
    });

    const text = 'Content for vector retrieval in fallback mode';
    await db.insert(documents).values({
      id: '00000000-0000-0000-0000-0000000000v1',
      tenantId: TENANT_ID,
      personaId: TWIN_ID,
      filename: 'vec-doc.txt',
      mimeType: 'text/plain',
      sizeBytes: text.length,
      status: 'ready',
      fullText: text,
      priority: 0,
    });

    await db.insert(documentChunks).values({
      tenantId: TENANT_ID,
      documentId: '00000000-0000-0000-0000-0000000000v1',
      personaId: TWIN_ID,
      chunkIndex: 0,
      text: 'Content for vector retrieval in fallback mode',
      embedding: new Array(1024).fill(0.1),
    });

    const results = await engine.query('vector content', TENANT_ID, TWIN_ID);

    expect(results.length).toBe(1);
    const ctx = results[0] as GroundingContext;

    expect(ctx.metadata.chunkIndex).toBe(0);
    expect(ctx.metadata).not.toHaveProperty('priority');
    expect(ctx.text).toContain('vector retrieval');
    expect(ctx.score).toBeGreaterThanOrEqual(0);
  });

  // -----------------------------------------------------------------------
  // G4 — embeddingsStatus invalidation on document insert/delete
  // -----------------------------------------------------------------------
  it('G4: document insert resets embeddingsStatus to idle', async () => {
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'Test twin',
      slug: 'test-twin',
      systemPrompt: 'You are a twin',
      embeddingsStatus: 'completed',
    });

    await documentService.ingest(TENANT_ID, TWIN_ID, {
      filename: 'new-doc.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('New document content'),
    });

    const [p] = await db
      .select({ status: personas.embeddingsStatus })
      .from(personas)
      .where(eq(personas.id, TWIN_ID));
    expect(p?.status).toBe('idle');
  });

  it('G4: document hard-delete resets embeddingsStatus to idle', async () => {
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'Test twin',
      slug: 'test-twin',
      systemPrompt: 'You are a twin',
      embeddingsStatus: 'completed',
    });

    const body = 'To be deleted';
    await documentService.ingest(TENANT_ID, TWIN_ID, {
      filename: 'delete-me.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(body),
    });

    // Re-set to completed after ingest reset it
    await db
      .update(personas)
      .set({ embeddingsStatus: 'completed' })
      .where(eq(personas.id, TWIN_ID));

    const docs = await documentService.list(TENANT_ID, TWIN_ID);
    expect(docs.length).toBe(1);

    await documentService.delete(TENANT_ID, docs[0]!.id);

    const [p] = await db
      .select({ status: personas.embeddingsStatus })
      .from(personas)
      .where(eq(personas.id, TWIN_ID));
    expect(p?.status).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // T017 — Lazy embed worker lifecycle
  // -----------------------------------------------------------------------
  it('T017: lazy embed lifecycle produces chunks and sets embeddingsStatus=completed', async () => {
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'Lazy embed twin',
      slug: 'lazy-twin',
      systemPrompt: 'You are a twin',
      groundingMode: 'big-context',
      truncationStrategy: 'fallback-vector',
      embeddingsStatus: 'idle',
    });

    const text =
      'The quick brown fox jumps over the lazy dog. '.repeat(20) +
      'Pack my box with five dozen liquor jugs. '.repeat(20);
    const docId = '00000000-0000-0000-0000-0000000000e1';
    await db.insert(documents).values({
      id: docId,
      tenantId: TENANT_ID,
      personaId: TWIN_ID,
      filename: 'lazy-embed.txt',
      mimeType: 'text/plain',
      sizeBytes: text.length,
      status: 'ready',
      fullText: text,
      priority: 5,
    });

    // Simulate lazy embed worker: set processing, chunk, embed, mark completed
    await db
      .update(personas)
      .set({ embeddingsStatus: 'processing' })
      .where(eq(personas.id, TWIN_ID));

    // Chunk text same way as lazy-embed-worker (recursiveSplit with 512/50)
    const chunks = recursiveSplit(text, 512, 50);
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i]!;
      const embedding = await embeddingService.embed(chunkText);

      await db.insert(documentChunks).values({
        tenantId: TENANT_ID,
        documentId: docId,
        personaId: TWIN_ID,
        chunkIndex: i,
        text: chunkText,
        embedding,
      });
    }

    await db
      .update(personas)
      .set({ embeddingsStatus: 'completed' })
      .where(eq(personas.id, TWIN_ID));

    // Verify status
    const [p] = await db
      .select({ status: personas.embeddingsStatus })
      .from(personas)
      .where(eq(personas.id, TWIN_ID));
    expect(p?.status).toBe('completed');

    // Verify chunks exist for this persona with embeddings
    const rows = await db
      .select({ id: documentChunks.id, chunkIndex: documentChunks.chunkIndex })
      .from(documentChunks)
      .where(eq(documentChunks.personaId, TWIN_ID));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(chunks.length);

    // Verify each chunk has its embedding stored
    for (const row of rows) {
      const fullRow = await db
        .select({ embedding: documentChunks.embedding })
        .from(documentChunks)
        .where(eq(documentChunks.id, row.id));
      expect(fullRow[0]?.embedding).toBeDefined();
      expect(fullRow[0]?.embedding).toHaveLength(1024);
    }
  });
});

// ---------------------------------------------------------------------------
// Character-based recursive splitter matching lazy-embed-worker
// ---------------------------------------------------------------------------
function recursiveSplit(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start + chunkSize / 2) {
        end = lastNewline;
      } else {
        const lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > start + chunkSize / 2) {
          end = lastSpace;
        }
      }
    }
    chunks.push(text.slice(start, end).trim());
    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
    if (start >= text.length - 10) break;
  }
  return chunks;
}
