import { fetch, Agent } from 'undici';
import { UpstreamError, GatewayTimeoutError } from '../lib/errors.js';
import type { RerankProvider } from './types.js';
import type { RerankResult } from '../types.js';

const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 10_000,
});

export class CohereRerankProvider implements RerankProvider {
  public readonly name = 'cohere';

  public async rerank(
    query: string,
    documents: string[],
    model: string,
    apiKey: string,
    signal: AbortSignal
  ): Promise<RerankResult[]> {
    const url = 'https://api.cohere.com/v1/rerank';

    const body = {
      model: model || 'rerank-multilingual-v3.0',
      query,
      documents,
      top_n: documents.length,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        dispatcher: agent,
        signal,
      });

      if (response.status !== 200) {
        const text = await response.text().catch(() => '');
        throw new UpstreamError(`Cohere Rerank provider returned status ${response.status}: ${text}`);
      }

      const data = (await response.json()) as any;

      if (!data || !Array.isArray(data.results)) {
        throw new UpstreamError('Cohere Rerank provider returned a malformed response');
      }

      return data.results.map((r: any) => {
        if (typeof r.index !== 'number' || typeof r.relevance_score !== 'number') {
          throw new UpstreamError('Cohere Rerank results are missing index or relevance_score');
        }
        return {
          index: r.index,
          score: r.relevance_score,
        };
      });
    } catch (error: any) {
      if (error instanceof UpstreamError) {
        throw error;
      }
      if (signal.aborted || error.name === 'AbortError' || error.message?.includes('timeout')) {
        throw new GatewayTimeoutError('Cohere Rerank upstream provider timed out');
      }
      throw new UpstreamError(`Cohere Rerank network/connection error: ${error.message}`);
    }
  }
}
