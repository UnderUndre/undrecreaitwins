import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const logger = pino({ name: 'dingtalk-adapter' });

const DINGTALK_API_BASE = 'https://oapi.dingtalk.com';

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class DingTalkAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private appKey: string;
  private appSecret: string;
  private token?: string;
  private aesKey?: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private server: Server;
  private port: number;
  private cachedToken: CachedToken | null = null;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const appKey = config.credentials['appKey'];
    if (typeof appKey !== 'string' || appKey.length === 0) {
      throw new AppError('DingTalk appKey is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const appSecret = config.credentials['appSecret'];
    if (typeof appSecret !== 'string' || appSecret.length === 0) {
      throw new AppError('DingTalk appSecret is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.appKey = appKey;
    this.appSecret = appSecret;
    this.token = typeof config.credentials['token'] === 'string'
      ? config.credentials['token']
      : undefined;
    this.aesKey = typeof config.credentials['aesKey'] === 'string'
      ? config.credentials['aesKey']
      : undefined;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3200;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);

    // Verify DingTalk signature
    const timestamp = req.headers['timestamp'] as string | undefined;
    const sign = req.headers['sign'] as string | undefined;

    if (this.token && timestamp && sign) {
      if (!this.verifySignature(timestamp, sign)) {
        logger.warn({ channelId: this.channelId }, 'DingTalk signature verification failed');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_signature' }));
        return;
      }
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Handle DingTalk callback event
    const msgType = payload['msgtype'] as string | undefined;
    const eventType = payload['EventType'] as string | undefined;

    if (eventType === 'check_url') {
      // URL verification for DingTalk callback registration
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Handle message events
    if (msgType === 'text' || eventType === 'conversation' || payload['content'] !== undefined) {
      const content = payload['content'] as Record<string, unknown> | undefined;
      const text = content !== undefined ? (content['text'] as string ?? '') : '';
      const senderId = payload['senderId'] as string ?? payload['SenderId'] as string ?? '';
      const conversationId = payload['conversationId'] as string ?? payload['ConversationId'] as string ?? '';

      if (text.length > 0 && senderId.length > 0) {
        const message: ChannelMessage = {
          id: payload['messageId'] as string ?? String(Date.now()),
          channelId: this.channelId,
          externalUserId: senderId,
          content: text,
          timestamp: new Date((payload['createAt'] as number) ?? Date.now()),
          metadata: {
            conversationId,
            senderNick: payload['senderNick'] as string,
            senderCorpId: payload['senderCorpId'] as string,
            isAdmin: payload['isAdmin'] as boolean,
            chatbotCorpId: payload['chatbotCorpId'] as string,
            chatbotUserId: payload['chatbotUserId'] as string,
          },
        };

        await this.transport.publish(REDIS_STREAMS.INBOUND, {
          channel_type: 'dingtalk',
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
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private verifySignature(timestamp: string, sign: string): boolean {
    const stringToSign = timestamp + '\n' + this.token;
    const hash = createHmac('sha256', this.aesKey ?? this.appSecret)
      .update(stringToSign)
      .digest('base64');
    // Constant-time compare — avoid timing attacks (gemini, security)
    const hashBuf = Buffer.from(hash, 'utf8');
    const signBuf = Buffer.from(sign, 'utf8');
    if (hashBuf.length !== signBuf.length) return false;
    return timingSafeEqual(hashBuf, signBuf);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.token;
    }

    const url = new URL(`${DINGTALK_API_BASE}/gettoken`);
    url.searchParams.set('appkey', this.appKey);
    url.searchParams.set('appsecret', this.appSecret);

    const body = await this.httpGet(url.toString());

    const parsed = JSON.parse(body) as Record<string, unknown>;
    const errcode = parsed['errcode'] as number;
    if (errcode !== 0) {
      throw new Error(`DingTalk gettoken error: ${parsed['errmsg'] ?? 'unknown'}`);
    }

    const token = parsed['access_token'] as string;
    const expiresIn = (parsed['expires_in'] as number) ?? 7200;

    this.cachedToken = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return token;
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? httpsRequest : httpRequest;
      mod(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }
          resolve(body);
        });
      }).on('error', reject).end();
    });
  }

  private httpPost(url: string, payload: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? httpsRequest : httpRequest;
      const req = mod(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
              return;
            }
            resolve(body);
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'DingTalk HTTP server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'DingTalk adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `dingtalk-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-dingtalk',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('dingtalk', {
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
          metadata: {
            conversationId: msg.data.dingtalk_conversation_id,
            agentId: msg.data.dingtalk_agent_id,
          },
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'DingTalk adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      const agentId = (message.metadata?.['agentId'] as string) ?? '';
      const userId = message.externalUserId;

      const payload = JSON.stringify({
        agent_id: agentId,
        userid_list: userId,
        msg: {
          msgtype: 'text',
          text: {
            content: message.content,
          },
        },
      });

      const url = `${DINGTALK_API_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token=${accessToken}`;
      const body = await this.httpPost(url, payload, {});

      const parsed = JSON.parse(body) as Record<string, unknown>;
      const errcode = parsed['errcode'] as number;
      if (errcode !== 0) {
        throw new Error(`DingTalk send error: ${parsed['errmsg'] ?? 'unknown'}`);
      }
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'DingTalk send failed');
      throw err;
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
