export interface DocumentMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GroundingContext {
  text: string;
  score: number;
  metadata: {
    documentId: string;
    chunkIndex: number;
  };
}

export interface IGroundingEngine {
  /**
   * Performs a hybrid search (full-text + vector) or semantic search to retrieve context.
   */
  query(query: string, twinId: string): Promise<GroundingContext[]>;

  /**
   * Parses the document, generates embeddings, and stores them in the pgvector database.
   */
  ingest(document: Buffer, meta: DocumentMeta, tenantId: string, twinId: string): Promise<void>;
}
