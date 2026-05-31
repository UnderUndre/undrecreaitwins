import { Queue } from 'bullmq';
import { withTenantContext } from '../db.js';
import { documents } from '../models/documents.js';
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
    this.queue = new Queue('document-ingestion', { 
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      }
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
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.personaId, personaId)));
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await withTenantContext(tenantId, async (tx) => {
      const [deleted] = await tx
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id });
      
      if (!deleted) throw new NotFoundError('Document', id);
    });
  }
}
