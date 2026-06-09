import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import { verifyWeComSignature } from '@undrecreaitwins/core/services/webhook-signature.js';
import { Redis } from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'wecom-adapter' });

const IDEMPOTENCY_TTL_SECONDS = 300;

interface WeComCredentials {
  token: string;
  encodingAesKey: string;
  corpId: string;
  agentId: string;
  corpSecret?: string;
}

interface WeComConfig {
  channelId: string;
  tenantId: string;
  personaSlug: string;
  redisUrl?: string;
  port?: number;
  credentials: WeComCredentials;
}

interface WeComXmlMessage {
  msgId: string;
  fromUserName: string;
  toUserName: string;
  content: string;
  msgType: string;
  createTime: string;
  agentId: string;
}

function parseXmlMessage(xml: string): WeComXmlMessage {
  const extract = (tag: string): string => {
    const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([^\\]]*)\\]\\]></${tag}>`))
      ?? xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match?.[1] ?? '';
  };

  return {
    msgId: extract('MsgId'),
    fromUserName: extract('FromUserName'),
    toUserName: extract('ToUserName'),
    content: extract('Content'),
    msgType: extract('MsgType'),
    createTime: extract('CreateTime'),
    agentId: extract('AgentID') || extract('AgentId'),
  };
}

function extractQueryParam(url: string, param: string): string | undefined {
  const match = url.match(new RegExp(`[?&]${param}=([^&]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export class WeComAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private idempotencyRedis: Redis;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private credentials: WeComCredentials;
  private port: number;
  private _status: ChannelStatus = 'disconnected';
  private server: Server | null = null;
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;

  constructor(config: WeComConfig) {
    if (!config.credentials?.token) {
      throw new AppError('WeCom token is required', 400, 'INVALID_CREDENTIALS');
    }
    if (!config.credentials?.encodingAesKey) {
      throw new AppError('WeCom encodingAesKey is required', 400, 'INVALID_CREDENTIALS');
    }
    if (!config.credentials?.corpId) {
      throw new AppError('WeCom corpId is required', 400, 'INVALID_CREDENTIALS');
    }
    if (!config.credentials?.agentId) {
      throw new AppError('WeCom agentId is required', 400, 'INVALID_CREDENTIALS');
    }

    this.transport = new ChannelTransport(config.redisUrl);
    this.idempotencyRedis = new Redis(config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.credentials = config.credentials;
    this.port = config.port ?? 3001;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'WeCom webhook server listening');
        resolve();
      });
      this.server!.on('error', (err) => {
        reject(err);
      });
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'WeCom adapter connected');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // WeCom URL verification: GET with echostr query param
    if (req.method === 'GET') {
      const echostr = extractQueryParam(url, 'echostr');
      const msgSignature = extractQueryParam(url, 'msg_signature');

      if (echostr && msgSignature) {
        const valid = verifyWeComSignature(echostr, msgSignature, this.credentials.token);
        if (!valid) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Invalid signature');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(echostr);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await this.readBody(req);

    // WeCom signature is in query params for POST as well
    const msgSignature = extractQueryParam(url, 'msg_signature');

    // Signature verification — MUST happen before any publish
    if (!msgSignature) {
      logger.warn({ channelId: this.channelId }, 'Missing msg_signature from WeCom webhook');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing signature' }));
      return;
    }

    const valid = verifyWeComSignature(body, msgSignature, this.credentials.token);
    if (!valid) {
      logger.warn({ channelId: this.channelId }, 'Invalid WeCom webhook signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Parse XML message
    const parsed = parseXmlMessage(body);

    if (!parsed.msgId || !parsed.fromUserName) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('success');
      return;
    }

    // Idempotency check
    const seenKey = `seen:wecom:${parsed.msgId}`;
    const set = await this.idempotencyRedis.set(seenKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    if (set !== 'OK') {
      logger.info({ msgId: parsed.msgId }, 'Duplicate WeCom message — already processed');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('success');
      return;
    }

    // Publish to INBOUND stream
    const channelMessage: ChannelMessage = {
      id: parsed.msgId,
      channelId: this.channelId,
      externalUserId: parsed.fromUserName,
      content: parsed.content,
      timestamp: new Date(parseInt(parsed.createTime, 10) * 1000 || Date.now()),
      metadata: {
        toUserName: parsed.toUserName,
        msgType: parsed.msgType,
        agentId: parsed.agentId,
        tenantId: this.tenantId,
      },
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, {
      channel_type: 'wecom',
      channel_id: this.channelId,
      message_id: parsed.msgId,
      persona_slug: this.personaSlug,
      content: parsed.content,
      tenant_id: this.tenantId,
      external_user_id: parsed.fromUserName,
    });

    if (this.incomingHandler) {
      await this.incomingHandler(channelMessage);
    }

    // WeCom expects "success" as plain text response
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('success');
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private startOutboundConsumer(): void {
    const consumerName = `wecom-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-wecom',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('wecom', {
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
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    await this.idempotencyRedis.quit();
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'WeCom adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const corpSecret = this.credentials.corpSecret;
    if (!corpSecret) {
      logger.warn({ channelId: this.channelId }, 'No WeCom corpSecret configured for sending');
      return;
    }

    try {
      // Get access token
      const tokenResponse = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.credentials.corpId}&corpsecret=${corpSecret}`,
      );
      const tokenData = await tokenResponse.json() as { access_token?: string; errcode?: number };

      if (!tokenData.access_token) {
        throw new Error(`WeCom token error: ${tokenData.errcode ?? 'unknown'}`);
      }

      // Send message
      const sendBody = JSON.stringify({
        touser: message.externalUserId,
        msgtype: 'text',
        agentid: parseInt(this.credentials.agentId, 10),
        text: { content: message.content },
      });

      const sendResponse = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: sendBody,
        },
      );

      const sendData = await sendResponse.json() as { errcode?: number; errmsg?: string };
      if (sendData.errcode !== 0) {
        throw new Error(`WeCom send error ${sendData.errcode}: ${sendData.errmsg}`);
      }
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'WeCom send failed');
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
