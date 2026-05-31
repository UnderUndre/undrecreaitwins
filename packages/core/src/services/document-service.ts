import { Queue } from 'bullmq';
import { db } from '../db.js';
import { documents } from '../models/documents.js';

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
    // Use explicit connection options to avoid multi-version ioredis type conflicts
    this.queue = new Queue('document-ingestion', { 
      connection: {
        host: 'localhost',
        port: 6379,
        ...(process.env.REDIS_URL ? this.parseRedisUrl(process.env.REDIS_URL) : {})
      }
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

  async ingest(
    content: Buffer,
    meta: { filename: string; mimeType: string; sizeBytes: number },
    tenantId: string,
    personaId: string,
  ) {
    // 1. Create document record in PENDING state
    const [doc] = await db.insert(documents).values({
      tenantId,
      personaId,
      filename: meta.filename,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      status: 'pending',
    }).returning();

    if (!doc) {
      throw new Error('Failed to create document record');
    }

    // 2. Enqueue the job
    await this.queue.add('ingest', {
      documentId: doc.id,
      tenantId,
      personaId,
      filename: meta.filename,
      mimeType: meta.mimeType,
      contentBase64: content.toString('base64'),
    });

    return { documentId: doc.id, status: doc.status };
  }

  async getDocumentStatus(documentId: string) {
    const doc = await db.query.documents.findFirst({
      where: (docs, { eq }) => eq(docs.id, documentId),
    });
    return doc ? doc.status : null;
  }
}
