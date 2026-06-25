import type { Job } from 'bullmq';
import pino from 'pino';
import { eq, and, isNotNull } from 'drizzle-orm';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { documents, documentChunks, personas } from '@undrecreaitwins/core/models/index.js';
import { embeddingService } from '@undrecreaitwins/core/services/index.js';
import type { LazyEmbedJobData } from './queue.js';

const logger = pino({ name: 'lazy-embed-worker' });

export async function processLazyEmbed(job: Job<LazyEmbedJobData>): Promise<void> {
  const { tenantId, personaId } = job.data;

  await withTenantContext(tenantId, async (tx) => {
    await tx
      .update(personas)
      .set({ embeddingsStatus: 'processing', updatedAt: new Date() })
      .where(eq(personas.id, personaId));
  });

  try {
    const docs = await withTenantContext(tenantId, async (tx) => {
      return tx
        .select({ id: documents.id, fullText: documents.fullText })
        .from(documents)
        .where(
          and(
            eq(documents.personaId, personaId),
            eq(documents.tenantId, tenantId),
            isNotNull(documents.fullText),
          ),
        );
    });

    for (const doc of docs) {
      const text = doc.fullText!;
      const chunks = recursiveSplit(text, 512, 50);

      await withTenantContext(tenantId, async (tx) => {
        await tx
          .delete(documentChunks)
          .where(
            and(
              eq(documentChunks.documentId, doc.id),
              eq(documentChunks.tenantId, tenantId),
            ),
          );
      });

      const chunkValues: Array<{
        tenantId: string;
        documentId: string;
        personaId: string;
        chunkIndex: number;
        text: string;
        embedding: number[];
      }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i]!;
        const embedding = await embeddingService.embed(chunkText);
        chunkValues.push({
          tenantId,
          documentId: doc.id,
          personaId,
          chunkIndex: i,
          text: chunkText,
          embedding,
        });
      }
      if (chunkValues.length > 0) {
        await withTenantContext(tenantId, async (tx) => {
          await tx.insert(documentChunks).values(chunkValues);
        });
      }
    }

    await withTenantContext(tenantId, async (tx) => {
      await tx
        .update(personas)
        .set({ embeddingsStatus: 'completed', updatedAt: new Date() })
        .where(eq(personas.id, personaId));
    });
  } catch (err) {
    logger.error({ err, tenantId, personaId }, 'Lazy embed job failed');

    await withTenantContext(tenantId, async (tx) => {
      await tx
        .update(personas)
        .set({ embeddingsStatus: 'idle', updatedAt: new Date() })
        .where(eq(personas.id, personaId));
    }).catch((resetErr) => {
      logger.error(
        { err: resetErr, tenantId, personaId },
        'Failed to reset embeddingsStatus to idle after failure',
      );
    });

    throw err;
  }
}

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
