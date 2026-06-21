import type { RerankResult } from '../types.js';

export interface EmbedProvider {
  readonly name: string;
  embed(
    inputs: string | string[],
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<number[] | number[][]>;
}

export interface RerankProvider {
  readonly name: string;
  rerank(
    query: string,
    documents: string[],
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<RerankResult[]>;
}
