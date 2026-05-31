import { Langfuse } from 'langfuse';

export class LangfuseService {
  private langfuse: Langfuse | null = null;

  constructor() {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const baseUrl = process.env.LANGFUSE_BASE_URL || 'http://localhost:3000';

    if (publicKey && secretKey) {
      this.langfuse = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
      });
    }
  }

  /**
   * Emits a trace for a chat reply fire-and-forget.
   * Swallows and logs errors to prevent reply path failure (gemini F5).
   */
  emitTrace(data: any): void {
    if (!this.langfuse) return;

    this.langfuse.trace(data);
    // Langfuse SDK handles batching and background sync by default.
    // We just need to make sure we don't block.
  }

  async pushToDataset(datasetName: string, item: any): Promise<string | undefined> {
    if (!this.langfuse) return;

    try {
      const result = await this.langfuse.createDatasetItem({
        datasetName,
        ...item,
      });
      return result.id;
    } catch (err) {
      console.warn({ err }, 'Langfuse dataset push failed');
      return undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.langfuse) {
      await this.langfuse.shutdownAsync();
    }
  }
}
