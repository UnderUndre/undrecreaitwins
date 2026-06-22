import { fetch, Agent } from 'undici';
import { UpstreamError, GatewayTimeoutError } from '../lib/errors.js';
import type { EmbedProvider } from './types.js';
import { config } from '../config.js';

const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 10_000,
});

export class OpenAIEmbedProvider implements EmbedProvider {
  public readonly name = 'openai';

  constructor() {
    console.warn(
      'WARINIG: OpenAI embedding provider is active. OpenAI returns 1536-dim vectors by default (text-embedding-3-small), but the database expects 1024-dim. Re-indexing will be required.'
    );
  }

  public async embed(
    inputs: string | string[],
    model: string,
    apiKey: string,
    signal: AbortSignal
  ): Promise<number[] | number[][]> {
    const url = `${config.OPENAI_BASE_URL}/embeddings`;

    const isBatch = Array.isArray(inputs);
    const body = {
      model: model || 'text-embedding-3-small',
      input: inputs,
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
        throw new UpstreamError(`OpenAI Embed provider returned status ${response.status}: ${text}`);
      }

      const data = (await response.json()) as any;

      if (!data || !data.data || !Array.isArray(data.data)) {
        throw new UpstreamError('OpenAI Embed provider returned a malformed response');
      }

      // Sort by index to preserve order
      const sortedData = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

      if (isBatch) {
        const embeddings = sortedData.map((d: any) => d.embedding);
        const firstDim = embeddings[0]?.length;
        if (firstDim && firstDim !== 1024) {
          console.warn(`[DIAGNOSTICS] Dimension mismatch: OpenAI returned ${firstDim}-dim vector, database expects 1024-dim.`);
        }
        return embeddings;
      } else {
        const first = sortedData[0];
        if (!first || !first.embedding) {
          throw new UpstreamError('OpenAI Embed provider returned an empty embedding array');
        }
        const dim = first.embedding.length;
        if (dim !== 1024) {
          console.warn(`[DIAGNOSTICS] Dimension mismatch: OpenAI returned ${dim}-dim vector, database expects 1024-dim.`);
        }
        return [first.embedding];
      }
    } catch (error: any) {
      if (error instanceof UpstreamError) {
        throw error;
      }
      if (signal.aborted || error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        throw new GatewayTimeoutError('OpenAI Embed upstream provider timed out');
      }
      throw new UpstreamError(`OpenAI Embed network/connection error: ${error.message}`);
    }
  }
}
