import { Queue } from 'bullmq';
import { withTenantContext } from '../db.js';
import { documents } from '../models/documents.js';
import { personas } from '../models/personas.js';
import { eq, and } from 'drizzle-orm';
import { NotFoundError } from '@undrecreaitwins/shared';
import type { IngestResult } from '../interfaces/IGroundingEngine.js';

export interface IngestJobData {
  documentId: string;
  tenantId: string;
  personaId: string;
  filename: string;
  mimeType: string;
  contentBase64: string; 
}

export class DocumentService {
  private queue: Queue<IngestJobData>;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.queue = new Queue('document-ingestion', { 
      connection: { url: redisUrl },
    });
  }

  async ingest(
    tenantId: string,
    personaId: string,
    file: { filename: string; mimeType: string; buffer: Buffer }
  ): Promise<IngestResult> {
    return withTenantContext(tenantId, async (tx) => {
      const [doc] = await tx
        .insert(documents)
        .values({
          tenantId,
          personaId,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.buffer.length,
          status: 'pending',
        })
        .returning({ id: documents.id, status: documents.status });

      if (!doc) throw new Error('Failed to create document');

      await tx
        .update(personas)
        .set({ embeddingsStatus: 'idle' })
        .where(eq(personas.id, personaId));

      await this.queue.add('ingest', {
        documentId: doc.id,
        tenantId,
        personaId,
        filename: file.filename,
        mimeType: file.mimeType,
        contentBase64: file.buffer.toString('base64'),
      });

      return { documentId: doc.id, status: doc.status as any };
    });
  }

  async list(tenantId: string, personaId: string) {
    return withTenantContext(tenantId, async (tx) => {
      return tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          personaId: documents.personaId,
          filename: documents.filename,
          mimeType: documents.mimeType,
          sizeBytes: documents.sizeBytes,
          status: documents.status,
          error: documents.error,
          priority: documents.priority,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.personaId, personaId)));
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await withTenantContext(tenantId, async (tx) => {
      const [deleted] = await tx
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id, personaId: documents.personaId });

      if (!deleted) throw new NotFoundError('Document', id);

      await tx
        .update(personas)
        .set({ embeddingsStatus: 'idle' })
        .where(eq(personas.id, deleted.personaId));
    });
  }

  async updatePriority(
    tenantId: string,
    documentId: string,
    priority: number,
  ): Promise<{ id: string; priority: number }> {
    return withTenantContext(tenantId, async (tx) => {
      const [updated] = await tx
        .update(documents)
        .set({ priority })
        .where(eq(documents.id, documentId))
        .returning({ id: documents.id, priority: documents.priority });

      if (!updated) throw new NotFoundError('Document', documentId);
      return updated;
    });
  }
}
