import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import WebSocket from 'ws';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const logger = pino({ name: 'homeassistant-adapter' });

interface HaMessage {
  type: string;
  [key: string]: unknown;
}

interface HaEvent {
  event_type?: string;
  data?: Record<string, unknown>;
}

export class HomeAssistantAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private hassUrl: string;
  private accessToken: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private ws: WebSocket | null = null;
  private messageIdCounter = 1;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const hassUrl = config.credentials['hassUrl'];
    if (typeof hassUrl !== 'string' || hassUrl.length === 0) {
      throw new AppError('Home Assistant hassUrl is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const accessToken = config.credentials['accessToken'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AppError('Home Assistant accessToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.hassUrl = hassUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
  }

  private buildWsUrl(): string {
    const url = new URL(this.hassUrl);
    if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    } else {
      url.protocol = 'ws:';
    }
    url.pathname = '/api/websocket';
    return url.toString();
  }

  private async connectWebSocket(): Promise<void> {
    const wsUrl = this.buildWsUrl();

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      const connectTimeout = setTimeout(() => {
        reject(new AppError('Home Assistant WebSocket connection timeout', 504, 'WS_TIMEOUT'));
        this.ws?.close();
      }, 15000);

      this.ws.on('open', () => {
        logger.info({ channelId: this.channelId }, 'WebSocket connected to Home Assistant, waiting for auth_required');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        const raw = typeof data === 'string' ? data : data.toString('utf8');
        let msg: HaMessage;
        try {
          msg = JSON.parse(raw) as HaMessage;
        } catch {
          logger.warn({ channelId: this.channelId }, 'Failed to parse HA WebSocket message');
          return;
        }

        if (msg.type === 'auth_required') {
          this.ws!.send(JSON.stringify({
            type: 'auth',
            access_token: this.accessToken,
          }));
          return;
        }

        if (msg.type === 'auth_ok') {
          clearTimeout(connectTimeout);
          logger.info({ channelId: this.channelId }, 'Home Assistant WebSocket authenticated');
          resolve();
          return;
        }

        if (msg.type === 'auth_invalid') {
          clearTimeout(connectTimeout);
          reject(new AppError('Home Assistant authentication failed', 401, 'INVALID_CREDENTIALS'));
          this.ws?.close();
          return;
        }

        this.handleWsMessage(msg).catch((err) => {
          logger.error({ err, channelId: this.channelId }, 'Error handling HA WebSocket message');
        });
      });

      this.ws.on('error', (err: Error) => {
        logger.error({ err, channelId: this.channelId }, 'Home Assistant WebSocket error');
        this._status = 'error';
        clearTimeout(connectTimeout);
        reject(err);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.info({ code, reason: reason.toString(), channelId: this.channelId }, 'Home Assistant WebSocket closed');
        if (this._status === 'active') {
          this._status = 'disconnected';
        }
        clearTimeout(connectTimeout);
      });
    });
  }

  private async subscribeToEvents(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscribeId = this.messageIdCounter++;

    // Subscribe to conversation events (HA conversation integration)
    this.ws.send(JSON.stringify({
      id: subscribeId,
      type: 'subscribe_events',
      event_type: 'conversation_response',
    }));

    // Also subscribe to state_changed for entities matching input_text.* pattern
    const stateSubId = this.messageIdCounter++;
    this.ws.send(JSON.stringify({
      id: stateSubId,
      type: 'subscribe_events',
      event_type: 'state_changed',
    }));

    logger.info({ channelId: this.channelId, subscribeIds: [subscribeId, stateSubId] }, 'Subscribed to HA events');
  }

  private async handleWsMessage(msg: HaMessage): Promise<void> {
    // Handle event messages from subscriptions
    if (msg.type === 'event' && msg['event']) {
      const event = msg['event'] as HaEvent;
      const eventType = event.event_type;

      if (eventType === 'conversation_response') {
        await this.handleConversationEvent(event);
      } else if (eventType === 'state_changed') {
        await this.handleStateChangedEvent(event);
      }
    }

    // Handle result messages (responses to our commands)
    if (msg.type === 'result') {
      if (msg['success'] === false) {
        logger.warn({ msg, channelId: this.channelId }, 'HA command returned error');
      }
    }
  }

  private async handleConversationEvent(event: HaEvent): Promise<void> {
    const data = event.data ?? {};
    const text = typeof data['text'] === 'string' ? data['text'] : '';
    const userId = typeof data['user_id'] === 'string' ? data['user_id'] : '';
    const conversationId = typeof data['conversation_id'] === 'string' ? data['conversation_id'] : '';

    if (!text) return;

    const message: ChannelMessage = {
      id: `ha-conv-${conversationId || Date.now()}`,
      channelId: this.channelId,
      externalUserId: userId || 'homeassistant_user',
      content: text,
      timestamp: new Date(),
      metadata: {
        eventType: 'conversation_response',
        conversationId,
      },
    };

    await this.publishInbound(message);
  }

  private async handleStateChangedEvent(event: HaEvent): Promise<void> {
    const data = event.data ?? {};
    const entityId = typeof data['entity_id'] === 'string' ? data['entity_id'] : '';

    // Only process input_text entities that indicate user input to the twin
    if (!entityId.startsWith('input_text.')) return;

    const newState = data['new_state'] as Record<string, unknown> | undefined;
    if (!newState) return;

    const text = typeof newState['state'] === 'string' ? newState['state'] : '';
    if (!text) return;

    const attributes = (newState['attributes'] ?? {}) as Record<string, unknown>;
    const userId = typeof attributes['source'] === 'string' ? attributes['source'] : 'homeassistant_user';

    const message: ChannelMessage = {
      id: `ha-state-${entityId}-${Date.now()}`,
      channelId: this.channelId,
      externalUserId: userId,
      content: text,
      timestamp: new Date(),
      metadata: {
        eventType: 'state_changed',
        entityId,
      },
    };

    await this.publishInbound(message);
  }

  private async publishInbound(message: ChannelMessage): Promise<void> {
    await this.transport.publish(REDIS_STREAMS.INBOUND, {
      channel_type: 'homeassistant',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: message.externalUserId,
    });

    if (this.incomingHandler) {
      await this.incomingHandler(message);
    }
  }

  async connect(): Promise<void> {
    await this.connectWebSocket();
    await this.subscribeToEvents();
    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Home Assistant adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `homeassistant-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-homeassistant',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('homeassistant', {
          content: msg.data.content ?? '',
        });
        if (!rateCheck.allowed) {
          logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
          return;
        }

        await this.send({
          id: msg.data.message_id ?? '',
          channelId: this.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Home Assistant adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const payload = JSON.stringify({
      text: message.content,
      language: 'en',
      agent_id: message.metadata?.['agentId'] ?? undefined,
    });

    const url = new URL(`${this.hassUrl}/api/conversation/process`);

    try {
      await new Promise<void>((resolve, reject) => {
        const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = mod(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.accessToken}`,
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
              } else {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                reject(new Error(`HA conversation process failed with status ${res.statusCode}: ${responseBody}`));
              }
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      logger.info({ channelId: this.channelId }, 'Home Assistant message sent via conversation API');
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Home Assistant send failed');
      throw err;
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
      ...(this.ws && this.ws.readyState === WebSocket.OPEN && {
        lastPingAt: new Date(),
      }),
    };
  }
}
