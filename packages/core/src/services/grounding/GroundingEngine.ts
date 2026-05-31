import { IGroundingEngine, GroundingContext, IngestResult, DocumentMeta } from '../../interfaces/IGroundingEngine.js';
import { EmbeddingService } from '../embedding-service.js';
import { DocumentService } from '../document-service.js';
import { retrieve } from './retrieval.js';

export class GroundingEngine implements IGroundingEngine {
  private embeddingService: EmbeddingService;
  private documentService: DocumentService;

  constructor(embeddingService: EmbeddingService, documentService: DocumentService) {
    this.embeddingService = embeddingService;
    this.documentService = documentService;
  }

  async query(query: string, tenantId: string, twinId: string): Promise<GroundingContext[]> {
    // twinId is personaId in the substrate
    return retrieve(query, tenantId, twinId, this.embeddingService);
  }

  async ingest(
    document: Buffer,
    meta: DocumentMeta,
    tenantId: string,
    twinId: string,
  ): Promise<IngestResult> {
    // twinId is personaId in the substrate
    return this.documentService.ingest(document, meta, tenantId, twinId);
  }
}
