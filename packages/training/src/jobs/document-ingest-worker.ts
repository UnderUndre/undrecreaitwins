import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
// @ts-ignore
import officeParser from 'officeparser';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { documents, documentChunks } from '@undrecreaitwins/core/models/index.js';
import { embeddingService } from '@undrecreaitwins/core/services/index.js';
import type { IngestJobData } from '@undrecreaitwins/core/services/document-service.js';

export async function processDocumentIngest(job: Job<IngestJobData>): Promise<void> {
  const { documentId, tenantId, personaId, contentBase64 } = job.data;
  const buffer = Buffer.from(contentBase64, 'base64');

  try {
    await withTenantContext(tenantId, async (tx) => {
      await tx
        .update(documents)
        .set({ status: 'parsing' })
        .where(eq(documents.id, documentId));
    });

    // 1. Parse document
    const text = await new Promise<string>((resolve, reject) => {
      officeParser.parseBuffer(buffer, (data: any, err: any) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    // 2. Chunk text
    const chunks = recursiveSplit(text, 512, 50);

    // 3. Vectorize and store chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i]!;
      const embedding = await embeddingService.embed(chunkText);

      await withTenantContext(tenantId, async (tx) => {
        try {
          await tx.insert(documentChunks).values({
            tenantId,
            documentId,
            personaId,
            chunkIndex: i,
            text: chunkText,
            embedding,
          });
        } catch (err: any) {
          // gemini F6: Catch CASCADE delete FK violation
          if (err.code === '23503') {
            console.warn(`Document ${documentId} deleted during ingestion, aborting chunk ${i}`);
            return;
          }
          throw err;
        }
      });
    }

    await withTenantContext(tenantId, async (tx) => {
      await tx
        .update(documents)
        .set({ status: 'ready' })
        .where(eq(documents.id, documentId));
    });

  } catch (err: any) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await withTenantContext(tenantId, async (tx) => {
      await tx
        .update(documents)
        .set({ status: 'failed', error: message })
        .where(eq(documents.id, documentId));
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
      // Try to find a good split point (newline or space)
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start + (chunkSize / 2)) {
        end = lastNewline;
      } else {
        const lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > start + (chunkSize / 2)) {
          end = lastSpace;
        }
      }
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start < 0) start = 0;
    if (start >= text.length - 10) break;
  }
  return chunks;
}
