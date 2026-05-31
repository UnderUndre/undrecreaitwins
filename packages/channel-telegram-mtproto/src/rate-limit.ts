import { errors } from 'telegram';

export class RateLimiter {
  private peerQueues: Map<string, Promise<any>> = new Map();

  async executeWithRetry<T>(
    peerId: string,
    operation: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    const currentQueue = this.peerQueues.get(peerId) || Promise.resolve();
    
    const nextOp = currentQueue.then(async () => {
      let attempts = 0;
      while (attempts < maxRetries) {
        try {
          return await operation();
        } catch (err: any) {
          // Check for FloodWaitError (GramJS specific)
          if (err.name === 'FloodWaitError' || err instanceof errors.FloodWaitError) {
            const waitSeconds = err.seconds;
            if (waitSeconds <= 60) {
              console.warn(`FloodWait for ${peerId}: waiting ${waitSeconds}s`);
              await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
              attempts++;
              continue;
            } else {
              console.error(`FloodWait for ${peerId} too long (${waitSeconds}s), dropping`);
              throw err; // Stop retrying immediately
            }
          }
          
          attempts++;
          if (attempts >= maxRetries) throw err;
          // For other errors, maybe add a small delay
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      throw new Error('Max retries exceeded');
    });

    this.peerQueues.set(peerId, nextOp.catch(() => {}).finally(() => {
      if (this.peerQueues.get(peerId) === nextOp) {
        this.peerQueues.delete(peerId);
      }
    }));
    return nextOp;
  }
}
