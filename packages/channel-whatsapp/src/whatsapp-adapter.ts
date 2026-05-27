import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport } from '@undrecreaitwins/core/services/channel-transport.js';
import { createHmac, timingSafeEqual } from 'crypto';

export class WhatsAppAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private evolutionUrl: string;
  private instanceId: string;
  private webhookSecret: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private webhookServer: Awaited<ReturnType<typeof import('fastify')>> | null = null;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    evolutionUrl: string;
    instanceId: string;
    webhookSecret: string;
    redisUrl?: string;
  }) {
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.evolutionUrl = config.evolutionUrl;
    this.instanceId = config.instanceId;
    this.webhookSecret = config.webhookSecret;
    this.transport = new ChannelTransport(config.redisUrl);
  }

  async connect(): Promise<void> {
    await this.startOutboundConsumer();
    await this.registerWebhook();
    this._status = 'active';
  }

  private async registerWebhook(): Promise<void> {
    const Fastify = (await import('fastify')).default;
    this.webhookServer = Fastify({ logger: false });

    this.webhookServer.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
        try {
          const parsed = body.length > 0 ? JSON.parse(body.toString('utf-8')) : {};
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    this.webhookServer.post('/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-signature'] as string | undefined;
      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody || !this.validateSignature(rawBody, signature)) {
        reply.status(401);
        return { error: 'Invalid signature' };
      }

      const payload = request.body as Record<string, unknown>;
      const data = payload.data as Record<string, unknown> | undefined;
      if (!data) return { ok: true };

      const key = data.key as Record<string, unknown> | undefined;
      const message = data.message as Record<string, unknown> | undefined;
      const messageText = message?.conversation as string | undefined;

      const channelMessage: ChannelMessage = {
        id: (key?.id as string) || '',
        channelId: this.channelId,
        externalUserId: (key?.remoteJid as string) || '',
        content: messageText || '',
        timestamp: new Date((data.messageTimestamp as number) * 1000 || Date.now()),
      };

      await this.transport.publish(REDIS_STREAMS.INBOUND, {
        channel_id: this.channelId,
        message_id: channelMessage.id,
        persona_slug: this.personaSlug,
        content: channelMessage.content,
        tenant_id: this.tenantId,
        external_user_id: channelMessage.externalUserId,
      });

      if (this.incomingHandler) {
        await this.incomingHandler(channelMessage);
      }

      return { ok: true };
    });

    const port = parseInt(process.env.WEBHOOK_PORT || '8091', 10);
    await this.webhookServer.listen({ port, host: '0.0.0.0' });
  }

  private validateSignature(payload: Buffer, signature?: string): boolean {
    if (!signature || !this.webhookSecret) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(payload).digest();
    const provided = Buffer.from(signature, 'hex');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private async startOutboundConsumer(): Promise<void> {
    await this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-whatsapp',
      `whatsapp-${this.channelId}`,
      async (msg) => {
        if (msg.data.channel_id !== this.channelId) return;
        await this.sendWithRetry({
          id: msg.data.message_id ?? '',
          channelId: this.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
        });
      },
    );
  }

  private async sendWithRetry(message: ChannelMessage, attempt = 0): Promise<void> {
    try {
      await this.send(message);
    } catch (error) {
      if (attempt >= 4) throw error;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await this.sendWithRetry(message, attempt + 1);
    }
  }

  async disconnect(): Promise<void> {
    if (this.webhookServer) {
      await this.webhookServer.close();
      this.webhookServer = null;
    }
    await this.transport.disconnect();
    this._status = 'disconnected';
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const url = `${this.evolutionUrl}/message/sendText/${this.instanceId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number: message.externalUserId.split('@')[0],
        text: message.content,
      }),
    });

    if (!response.ok) {
      this._status = 'error';
      throw new Error(`Evolution API error: ${response.status}`);
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
