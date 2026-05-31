import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { MtprotoAdapterOptions } from './types.js';

export class MtprotoClient {
  private client: TelegramClient | null = null;

  constructor(private readonly opts: MtprotoAdapterOptions) {}

  async connect(): Promise<TelegramClient> {
    if (this.client) return this.client;

    const apiHash = await this.opts.secrets.getApiHash(this.opts.channelId);
    const sessionString = await this.opts.secrets.getSessionString(this.opts.channelId);

    const session = new StringSession(sessionString);
    
    this.client = new TelegramClient(session, this.opts.apiId, apiHash, {
      connectionRetries: 5,
      useWSS: false, // Standard TCP for workers
    });

    await this.client.connect();
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  getClient(): TelegramClient {
    if (!this.client) throw new Error('Client not connected');
    return this.client;
  }
}
