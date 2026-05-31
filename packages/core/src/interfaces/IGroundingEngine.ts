export interface DocumentMeta {
  filename: string;
  mimeType:
    | 'application/pdf'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'text/plain';
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

export type DocumentStatus = 'pending' | 'parsing' | 'ready' | 'failed';

export interface IngestResult {
  documentId: string;
  status: DocumentStatus;
}

export interface IGroundingEngine {
  query(query: string, tenantId: string, twinId: string): Promise<GroundingContext[]>;
  ingest(
    document: Buffer,
    meta: DocumentMeta,
    tenantId: string,
    twinId: string,
  ): Promise<IngestResult>;
}
