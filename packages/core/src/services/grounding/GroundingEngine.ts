import { eq } from 'drizzle-orm';
import pino from 'pino';
import { IGroundingEngine, GroundingContext, DocumentContext, IngestResult, DocumentMeta } from '../../interfaces/IGroundingEngine.js';
import { EmbeddingService } from '../embedding-service.js';
import { DocumentService } from '../document-service.js';
import { retrieve, retrieveBigContext } from './retrieval.js';
import { db } from '../../db.js';
import { personas } from '../../models/personas.js';
import { tenants } from '../../models/tenants.js';

const logger = pino({ name: 'grounding-engine' });

export class GroundingEngine implements IGroundingEngine {
  private embeddingService: EmbeddingService;
  private documentService: DocumentService;

  constructor(embeddingService: EmbeddingService, documentService: DocumentService) {
    this.embeddingService = embeddingService;
    this.documentService = documentService;
  }

  async query(query: string, tenantId: string, twinId: string): Promise<GroundingContext[] | DocumentContext[]> {
    const effectiveMode = await this.resolveGroundingMode(tenantId, twinId);

    if (effectiveMode === 'big-context') {
      logger.info({ tenantId, personaId: twinId }, 'Using big-context grounding mode');

      const [personaRow] = await db
        .select({
          truncationStrategy: personas.truncationStrategy,
          embeddingsStatus: personas.embeddingsStatus,
        })
        .from(personas)
        .where(eq(personas.id, twinId));

      if (personaRow?.truncationStrategy === 'fallback-vector') {
        if (personaRow.embeddingsStatus === 'completed') {
          logger.info({ tenantId, personaId: twinId }, 'Fallback-vector: embeddings ready, using vector search');
          return retrieve(query, tenantId, twinId, this.embeddingService);
        }

        logger.warn({
          tenantId,
          personaId: twinId,
          embeddingsStatus: personaRow.embeddingsStatus,
        }, 'Fallback-vector strategy skipped: embeddings not completed, using silent truncation');
      }

      return retrieveBigContext(tenantId, twinId);
    }

    return retrieve(query, tenantId, twinId, this.embeddingService);
  }

  private async resolveGroundingMode(tenantId: string, personaId: string): Promise<'vector' | 'big-context'> {
    const [personaRow] = await db
      .select({ groundingMode: personas.groundingMode })
      .from(personas)
      .where(eq(personas.id, personaId));

    if (personaRow?.groundingMode) {
      return personaRow.groundingMode;
    }

    const [tenantRow] = await db
      .select({ groundingMode: tenants.groundingMode })
      .from(tenants)
      .where(eq(tenants.id, tenantId));

    if (tenantRow?.groundingMode) {
      return tenantRow.groundingMode;
    }

    return 'vector';
  }

  async ingest(
    document: Buffer,
    meta: DocumentMeta,
    tenantId: string,
    twinId: string,
  ): Promise<IngestResult> {
    return this.documentService.ingest(tenantId, twinId, {
      filename: meta.filename,
      mimeType: meta.mimeType,
      buffer: document,
    });
  }
}
