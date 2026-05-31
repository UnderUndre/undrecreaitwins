import { ServiceUnavailableError } from '@undrecreaitwins/shared';

export interface RerankResult {
  index: number;
  score: number;
}

/**
 * Client for the TEI (Text Embeddings Inference) sidecar.
 * Serves BGE-M3 (embeddings) and BGE-reranker-v2-m3 (reranking).
 */
export class EmbeddingService {
  private embeddingsUrl: string;

  constructor() {
    this.embeddingsUrl = process.env.EMBEDDINGS_URL || 'http://localhost:8080';
  }

  /**
   * Generates a 1024-dimensional embedding for the input text using BGE-M3.
   */
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.embeddingsUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: text }),
    });

    if (!response.ok) {
      throw new ServiceUnavailableError('Embedding service', `Provider returned ${response.status} at ${this.embeddingsUrl}/embed`);
    }

    // TEI returns an array of embeddings for multiple inputs.
    // We only send one, so we take the first.
    const data = await response.json() as number[][];
    if (!data || !data[0]) {
      throw new ServiceUnavailableError('Embedding service', 'Provider returned empty embedding data');
    }
    return data[0];
  }

  /**
   * Reranks a set of documents against a query using BGE-reranker-v2-m3.
   * Higher score = more relevant.
   */
  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (documents.length === 0) return [];

    const response = await fetch(`${this.embeddingsUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, documents }),
    });

    if (!response.ok) {
      throw new ServiceUnavailableError('Reranking service', `Provider returned ${response.status} at ${this.embeddingsUrl}/rerank`);
    }

    return await response.json() as RerankResult[];
  }
}
