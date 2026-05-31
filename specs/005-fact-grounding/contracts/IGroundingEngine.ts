export interface DocumentMeta {
  filename: string;
  /** Enum-checked at 008 ingest: pdf / docx / txt only (008 FR-007). */
  mimeType:
    | 'application/pdf'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'text/plain';
  /** ≤ 10 MB, enforced at the 008 upload boundary. */
  sizeBytes: number;
}

export interface GroundingContext {
  text: string;
  /** BGE-reranker-v2-m3 relevance score (0..1). Chunks below minRerankScore are dropped. */
  score: number;
  metadata: {
    documentId: string;
    chunkIndex: number;
  };
}

/** Async ingestion status — mirrors the 008 document lifecycle. */
export type DocumentStatus = 'pending' | 'parsing' | 'ready' | 'failed';

export interface IngestResult {
  documentId: string;
  status: DocumentStatus;
}

export interface IGroundingEngine {
  /**
   * Retrieve grounded context via vector search (HNSW cosine) + BGE-reranker-v2-m3.
   * Full-text / hybrid is deferred — see spec.md §11.
   *
   * @param query    User text to ground.
   * @param tenantId REQUIRED — opens Postgres RLS via withTenantContext()
   *                 (SET LOCAL app.current_tenant). Retrieval is impossible without it.
   * @param twinId   Identity with personaId in the 008 substrate (one twin = one persona,
   *                 no lookup). Chunks are filtered by personaId = twinId WITHIN the tenant context.
   * @returns Ranked contexts, or [] when no chunk passes minRerankScore (no-context).
   *          Only chunks of documents with status === 'ready' are eligible.
   */
  query(query: string, tenantId: string, twinId: string): Promise<GroundingContext[]>;

  /**
   * Enqueue ASYNC ingestion via the shared 008 document-service
   * (BullMQ pipeline: officeParser parse → chunk → embed → store). 005 does NOT
   * reimplement parsing/embedding/storage. Returns immediately; the document becomes
   * retrievable only after status === 'ready'. Poll/subscribe for the terminal state.
   *
   * Rejects (typed error, before enqueue) on: unsupported MIME, size > 10 MB,
   * or per-persona document limit exceeded. Parse/embed failures surface as
   * status === 'failed' (no half-ingested document persisted).
   */
  ingest(
    document: Buffer,
    meta: DocumentMeta,
    tenantId: string,
    twinId: string,
  ): Promise<IngestResult>;
}
