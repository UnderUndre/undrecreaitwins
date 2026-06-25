import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { GroundingEngine } from '../../../src/services/grounding/GroundingEngine.js';
import { ChatService } from '../../../src/services/chat-service.js';
import { EmbeddingService } from '../../../src/services/embedding-service.js';
import { DocumentService } from '../../../src/services/document-service.js';
import { DocumentWorker } from '../../../src/services/document-worker.js';
import { LLMClient } from '../../../src/services/llm-client.js';
import { db } from '../../../src/db.js';
import { documents, documentChunks, personas, tenants } from '../../../src/models/index.js';
import type { DocumentContext } from '../../../src/interfaces/IGroundingEngine.js';

// ---------------------------------------------------------------------------
// T024: Golden-Q&A regression suite
// Verifies SC-001 (factual accuracy in big-context mode) via:
//   1. (Deterministic) correct document is grounded — checked via trace
//      metadata (DocumentContext.metadata.documentId), FR-010
//   2. (Threshold metric) model prompt contains the expected exact token —
//      configurable threshold across N=3 runs
// ---------------------------------------------------------------------------

const HOODIE_TEXT = 'The premium hoodie costs 7880₽ and comes in black, navy, and burgundy. SKU: HD-7880-NAV.';
const SHOES_TEXT  = 'Running shoes Pro model: 12490₽, available in sizes 39-45. SKU: RS-12490-BLK.';
const PHONE_TEXT  = 'Customer support phone: +7 495 123-45-67. Hours: Mon-Fri 9:00-20:00.';

const HOODIE_ID = '00000000-0000-0000-0000-000000000100';
const SHOES_ID  = '00000000-0000-0000-0000-000000000101';
const PHONE_ID  = '00000000-0000-0000-0000-000000000102';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TWIN_ID   = '00000000-0000-0000-0000-000000000002';

const N_RUNS = 3;
const THRESHOLD = 2; // >= 2/3 passes required

describe('T024 — Golden-Q&A regression suite (SC-001)', () => {
  let engine: GroundingEngine;
  let embeddingService: EmbeddingService;
  let documentService: DocumentService;
  let documentWorker: DocumentWorker;

  beforeEach(async () => {
    embeddingService = new EmbeddingService();
    documentService = new DocumentService();
    documentWorker = new DocumentWorker(embeddingService);
    engine = new GroundingEngine(embeddingService, documentService);

    vi.spyOn(embeddingService, 'embed').mockResolvedValue(new Array(1024).fill(0.1));
    vi.spyOn(embeddingService, 'rerank').mockResolvedValue([{ index: 0, score: 0.9 }]);

    // Ensure any LLM call during prompt building is deterministic
    vi.spyOn(LLMClient.prototype, 'complete').mockResolvedValue({
      content: 'en',
      model: 'gpt-4o',
      finishReason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });

    await db.delete(documentChunks);
    await db.delete(documents);
    await db.delete(personas);
    await db.delete(tenants);

    await db.insert(tenants).values({ id: TENANT_ID, name: 'Golden-QA Tenant', slug: 'golden-qa' });

    // Persona in big-context mode (SC-001 target)
    await db.insert(personas).values({
      id: TWIN_ID,
      tenantId: TENANT_ID,
      name: 'Golden-QA Twin',
      slug: 'golden-qa',
      systemPrompt: 'You are a helpful assistant that answers questions based on the provided documents.',
      groundingMode: 'big-context',
    });

    // Insert three fixed test documents
    await db.insert(documents).values([
      {
        id: HOODIE_ID,
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'hoodie.txt',
        mimeType: 'text/plain',
        sizeBytes: HOODIE_TEXT.length,
        status: 'ready',
        fullText: HOODIE_TEXT,
        priority: 0,
      },
      {
        id: SHOES_ID,
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'shoes.txt',
        mimeType: 'text/plain',
        sizeBytes: SHOES_TEXT.length,
        status: 'ready',
        fullText: SHOES_TEXT,
        priority: 0,
      },
      {
        id: PHONE_ID,
        tenantId: TENANT_ID,
        personaId: TWIN_ID,
        filename: 'phone.txt',
        mimeType: 'text/plain',
        sizeBytes: PHONE_TEXT.length,
        status: 'ready',
        fullText: PHONE_TEXT,
        priority: 0,
      },
    ]);
  });

  afterAll(async () => {
    await documentWorker.close();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Hard gate — deterministic: correct document grounded (FR-010)
  // -----------------------------------------------------------------------
  describe('Deterministic — correct document grounded (FR-010)', () => {
    it('hoodie cost query grounds hoodie document', async () => {
      const results = await engine.query('How much does the hoodie cost?', TENANT_ID, TWIN_ID);

      const docs = results as DocumentContext[];
      const hoodieDoc = docs.find(d => d.metadata.documentId === HOODIE_ID);
      expect(hoodieDoc).toBeDefined();
      expect(hoodieDoc!.text).toContain('7880₽');
      expect(hoodieDoc!.text).toContain('black, navy, and burgundy');
      expect(hoodieDoc!.filename).toBe('hoodie.txt');
    });

    it('support phone query grounds phone document', async () => {
      const results = await engine.query("What's the support phone number?", TENANT_ID, TWIN_ID);

      const docs = results as DocumentContext[];
      const phoneDoc = docs.find(d => d.metadata.documentId === PHONE_ID);
      expect(phoneDoc).toBeDefined();
      expect(phoneDoc!.text).toContain('+7 495 123-45-67');
      expect(phoneDoc!.filename).toBe('phone.txt');
    });

    it('hoodie colors query grounds hoodie document', async () => {
      const results = await engine.query('What colors does the hoodie come in?', TENANT_ID, TWIN_ID);

      const docs = results as DocumentContext[];
      const hoodieDoc = docs.find(d => d.metadata.documentId === HOODIE_ID);
      expect(hoodieDoc).toBeDefined();
      expect(hoodieDoc!.text).toContain('black, navy, and burgundy');
      expect(hoodieDoc!.filename).toBe('hoodie.txt');
    });
  });

  // -----------------------------------------------------------------------
  // Soft gate — threshold metric: prompt contains expected exact token
  // -----------------------------------------------------------------------
  describe('Threshold metric — exact match in prompt (N=3, threshold >= 2/3)', () => {
    it('hoodie cost prompt includes "7880₽"', async () => {
      const chatService = new ChatService();
      const persona = {
        id: TWIN_ID,
        tenantId: TENANT_ID,
        systemPrompt: 'You are a helpful assistant.',
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

      let passes = 0;
      for (let i = 0; i < N_RUNS; i++) {
        const result = await (ChatService.prototype as any).buildSystemPrompt.call(
          chatService,
          TENANT_ID,
          persona,
          'How much does the hoodie cost?',
          undefined,
        );
        if (result.prompt.includes('7880₽')) passes++;
      }

      expect(passes).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it('support phone prompt includes "+7 495" or "123-45-67"', async () => {
      const chatService = new ChatService();
      const persona = {
        id: TWIN_ID,
        tenantId: TENANT_ID,
        systemPrompt: 'You are a helpful assistant.',
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

      let passes = 0;
      for (let i = 0; i < N_RUNS; i++) {
        const result = await (ChatService.prototype as any).buildSystemPrompt.call(
          chatService,
          TENANT_ID,
          persona,
          "What's the support phone number?",
          undefined,
        );
        const prompt = result.prompt as string;
        if (prompt.includes('+7 495') || prompt.includes('123-45-67')) passes++;
      }

      expect(passes).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it('hoodie colors prompt includes "black, navy, and burgundy"', async () => {
      const chatService = new ChatService();
      const persona = {
        id: TWIN_ID,
        tenantId: TENANT_ID,
        systemPrompt: 'You are a helpful assistant.',
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

      let passes = 0;
      for (let i = 0; i < N_RUNS; i++) {
        const result = await (ChatService.prototype as any).buildSystemPrompt.call(
          chatService,
          TENANT_ID,
          persona,
          'What colors does the hoodie come in?',
          undefined,
        );
        if (result.prompt.includes('black, navy, and burgundy')) passes++;
      }

      expect(passes).toBeGreaterThanOrEqual(THRESHOLD);
    });
  });
});
