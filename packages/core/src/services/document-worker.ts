import { Worker, Job } from 'bullmq';
import officeParser from 'officeparser';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { db } from '../db.js';
import { documents, documentChunks } from '../models/documents.js';
import { personas } from '../models/personas.js';
import { tenants } from '../models/tenants.js';
import { EmbeddingService } from './embedding-service.js';
import { eq } from 'drizzle-orm';
import type { IngestJobData } from './document-service.js';

/**
 * Test-only document ingestion worker.
 *
 * Production document-ingestion is handled by
 * `packages/training/src/jobs/document-ingest-worker.ts` which uses
 * `withTenantContext`, FK-violation handling, and character-based splitting.
 *
 * This class exists solely for integration tests and intentionally binds to
 * `'document-ingestion-test'` (not `'document-ingestion'`) to avoid competing
 * with the production training worker.
 */
export class DocumentWorker {
  private worker: Worker<IngestJobData>;
  private embeddingService: EmbeddingService;

  /**
   * @param embeddingService - embedding service instance (mocked in tests)
   * @param queueName - queue to consume. Defaults to 'document-ingestion-test'.
   *   MUST NOT be 'document-ingestion' — that queue belongs to the training worker.
   */
  constructor(
    embeddingService: EmbeddingService,
    queueName: string = 'document-ingestion-test',
  ) {
    if (queueName === 'document-ingestion') {
      throw new Error(
        "DocumentWorker must not bind to 'document-ingestion' queue — " +
          "that queue is owned by the training worker (packages/training/src/jobs/). " +
          "Use 'document-ingestion-test' or a custom name for test isolation.",
      );
    }

    this.embeddingService = embeddingService;

    this.worker = new Worker<IngestJobData>(
      queueName,
      async (job: Job<IngestJobData>) => {
        await this.processIngest(job);
      },
      {
        connection: {
          host: 'localhost',
          port: 6379,
          ...(process.env.REDIS_URL ? this.parseRedisUrl(process.env.REDIS_URL) : {}),
        },
      },
    );

    this.worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed with error: ${err.message}`);
    });
  }

  private parseRedisUrl(url: string) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: parseInt(u.port, 10) || 6379,
        password: u.password,
      };
    } catch {
      return {};
    }
  }

  private async processIngest(job: Job<IngestJobData>) {
    const { documentId, contentBase64, tenantId, personaId, mimeType } = job.data;

    try {
      // 1. Update status to 'parsing'
      await db
        .update(documents)
        .set({ status: 'parsing' })
        .where(eq(documents.id, documentId));

      // 2. Parse content based on mimeType
      const buffer = Buffer.from(contentBase64, 'base64');
      const text = await this.extractText(buffer, mimeType);

      // 3. Store fullText + reset embeddingsStatus transactionally
      await db.transaction(async (tx) => {
        await tx
          .update(documents)
          .set({ fullText: text })
          .where(eq(documents.id, documentId));

        await tx
          .update(personas)
          .set({ embeddingsStatus: 'idle' })
          .where(eq(personas.id, personaId));
      });

      // 4. Determine effective grounding mode
      const [personaRow] = await db
        .select({ groundingMode: personas.groundingMode })
        .from(personas)
        .where(eq(personas.id, personaId));

      let effectiveMode: 'vector' | 'big-context' = 'vector';
      if (personaRow?.groundingMode) {
        effectiveMode = personaRow.groundingMode;
      } else {
        const [tenantRow] = await db
          .select({ groundingMode: tenants.groundingMode })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        if (tenantRow?.groundingMode) {
          effectiveMode = tenantRow.groundingMode;
        }
      }

      if (effectiveMode === 'vector') {
        // 5. Chunk text (word-based splitter — adequate for tests)
        const chunks = this.splitText(text, 512, 50);

        // 6. Embed and store chunks
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i];
          if (!chunkText) continue;

          const embedding = await this.embeddingService.embed(chunkText);

          await db.insert(documentChunks).values({
            tenantId,
            documentId,
            personaId,
            chunkIndex: i,
            text: chunkText,
            embedding,
          });
        }
      }

      // 7. Update status to 'ready'
      await db
        .update(documents)
        .set({ status: 'ready' })
        .where(eq(documents.id, documentId));
    } catch (err: any) {
      console.error(`Failed to ingest document ${documentId}:`, err);
      await db
        .update(documents)
        .set({ status: 'failed', error: err.message })
        .where(eq(documents.id, documentId));
      throw err;
    }
  }

  private async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    if (mimeType === 'application/pdf') {
      const pdf = new PDFParse({ data: buffer });
      const result = await pdf.getText();
      return result.text;
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    return new Promise<string>((resolve, reject) => {
      officeParser.parseOffice(buffer, (data: any, err: any) => {
        if (err) return reject(err);
        resolve(data as string);
      });
    });
  }

  private splitText(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    const words = text.split(/\s+/).filter(Boolean);

    let start = 0;
    while (start < words.length) {
      const end = Math.min(start + chunkSize, words.length);
      chunks.push(words.slice(start, end).join(' '));
      if (end === words.length) break;
      start += chunkSize - overlap;
    }

    return chunks;
  }

  async close() {
    await this.worker.close();
  }
}
