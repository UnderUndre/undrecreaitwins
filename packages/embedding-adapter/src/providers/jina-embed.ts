import { fetch, Agent } from 'undici';
import { UpstreamError, GatewayTimeoutError } from '../lib/errors.js';
import type { EmbedProvider } from './types.js';

const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 10_000,
});

export class JinaEmbedProvider implements EmbedProvider {
  public readonly name = 'jina';

  public async embed(
    inputs: string | string[],
    model: string,
    apiKey: string,
    signal: AbortSignal
  ): Promise<number[] | number[][]> {
    const url = 'https://api.jina.ai/v1/embeddings';

    const isBatch = Array.isArray(inputs);
    const body = {
      model: model || 'jina-embeddings-v3',
      input: inputs,
      dimensions: 1024,
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
        throw new UpstreamError(`Jina Embed provider returned status ${response.status}: ${text}`);
      }

      const data = (await response.json()) as any;

      if (!data || !data.data || !Array.isArray(data.data)) {
        throw new UpstreamError('Jina Embed provider returned a malformed response');
      }

      // Sort by index to preserve order
      const sortedData = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

      if (isBatch) {
        return sortedData.map((d: any) => d.embedding);
      } else {
        const first = sortedData[0];
        if (!first || !first.embedding) {
          throw new UpstreamError('Jina Embed provider returned an empty embedding array');
        }
        return [first.embedding];
      }
    } catch (error: any) {
      if (error instanceof UpstreamError) {
        throw error;
      }
      if (signal.aborted || error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        throw new GatewayTimeoutError('Jina Embed upstream provider timed out');
      }
      throw new UpstreamError(`Jina Embed network/connection error: ${error.message}`);
    }
  }
}
