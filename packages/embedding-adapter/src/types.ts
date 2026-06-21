export interface EmbedRequest {
  inputs: string | string[];
}

export interface RerankRequest {
  query: string;
  documents: string[];
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface HealthResponse {
  status: 'ok';
  provider: string;
}
