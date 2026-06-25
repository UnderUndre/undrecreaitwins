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

export interface DocumentContext {
  text: string;
  score: number;
  metadata: {
    documentId: string;
    priority: number;
  };
  filename: string;
}

export type DocumentStatus = 'pending' | 'parsing' | 'ready' | 'failed';

export interface IngestResult {
  documentId: string;
  status: DocumentStatus;
}

export interface IGroundingEngine {
  query(query: string, tenantId: string, twinId: string): Promise<GroundingContext[] | DocumentContext[]>;
  ingest(
    document: Buffer,
    meta: DocumentMeta,
    tenantId: string,
    twinId: string,
  ): Promise<IngestResult>;
  queryWithMode?(query: string, tenantId: string, twinId: string, mode: 'vector' | 'big-context'): Promise<GroundingContext[] | DocumentContext[]>;
}
