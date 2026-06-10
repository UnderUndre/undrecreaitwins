import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus, ChannelAttachment } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import { verifySlackSignature } from '@undrecreaitwins/core/services/webhook-signature.js';
import pino from 'pino';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const logger = pino({ name: 'slack-adapter' });

const CRLF = '\r\n';

function classifyAttachmentKind(mimetype: string | undefined): ChannelAttachment['kind'] {
  if (!mimetype) return 'file';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  return 'file';
}

interface SlackFile {
  id?: string;
  url_private?: string;
  mimetype?: string;
  name?: string;
  size?: number;
}

function extractSlackAttachments(files: SlackFile[] | undefined): ChannelAttachment[] {
  if (!files || files.length === 0) return [];
  return files.map((f) => ({
    kind: classifyAttachmentKind(f.mimetype),
    url: f.url_private,
    mime: f.mimetype ?? 'application/octet-stream',
    filename: f.name,
  }));
}

export class SlackAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private botToken: string;
  private signingSecret: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private server: Server;
  private port: number;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const botToken = config.credentials['botToken'];
    if (typeof botToken !== 'string' || botToken.length === 0) {
      throw new AppError('Slack botToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const signingSecret = config.credentials['signingSecret'];
    if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
      throw new AppError('Slack signingSecret is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.botToken = botToken;
    this.signingSecret = signingSecret;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3100;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);

    // Slack URL verification challenge
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    if (!this.verifySignature(body, timestamp as string | undefined, signature as string | undefined)) {
      logger.warn({ channelId: this.channelId }, 'Slack signature verification failed');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Handle URL verification challenge
    if (payload['type'] === 'url_verification' && typeof payload['challenge'] === 'string') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: payload['challenge'] }));
      return;
    }

    // Handle event callback
    if (payload['type'] === 'event_callback') {
      const event = payload['event'] as Record<string, unknown> | undefined;
      if (event && event['type'] === 'message') {
        // Ignore bot messages + unsupported subtypes (edits, deletes, joins) — gemini
        if (event['bot_id'] || event['subtype'] === 'bot_message' || (event['subtype'] && event['subtype'] !== 'file_share')) {
          res.writeHead(200).end();
          return;
        }

        const slackFiles = event['subtype'] === 'file_share'
          ? (event['files'] as SlackFile[] | undefined)
          : undefined;
        const attachments = extractSlackAttachments(slackFiles);

        const message: ChannelMessage = {
          id: event['event_ts'] as string ?? String(Date.now()),
          channelId: this.channelId,
          externalUserId: event['user'] as string ?? '',
          content: event['text'] as string ?? '',
          timestamp: new Date(parseFloat(event['ts'] as string ?? Date.now())),
          metadata: {
            channel: event['channel'],
            threadTs: event['thread_ts'],
          },
          ...(attachments.length > 0 && { attachments }),
        };

        const publishPayload: Record<string, string> = {
          channel_type: 'slack',
          channel_id: this.channelId,
          message_id: message.id,
          persona_slug: this.personaSlug,
          content: message.content,
          tenant_id: this.tenantId,
          external_user_id: (event['channel'] as string) ?? '',
        };

        if (attachments.length > 0) {
          publishPayload.attachments_json = JSON.stringify(attachments.map((a) => ({
            kind: a.kind,
            url: a.url,
            mime: a.mime,
            filename: a.filename,
          })));
        }

        await this.transport.publish(REDIS_STREAMS.INBOUND, publishPayload);

        if (this.incomingHandler) {
          await this.incomingHandler(message);
        }
      }

      res.writeHead(200).end();
      return;
    }

    res.writeHead(200).end();
  }

  private verifySignature(
    body: string,
    timestamp?: string,
    signature?: string,
  ): boolean {
    if (!timestamp || !signature) return false;
    return verifySlackSignature(body, timestamp, signature, this.signingSecret);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'Slack HTTP server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Slack adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `slack-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-slack',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('slack', {
          content: msg.data.content ?? '',
        });
        if (!rateCheck.allowed) {
          logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
          return;
        }

        let attachments: ChannelAttachment[] | undefined;
        if (msg.data.attachments_json) {
          try {
            attachments = JSON.parse(msg.data.attachments_json) as ChannelAttachment[];
          } catch {
            logger.warn({ channelId: this.channelId }, 'Failed to parse attachments_json from outbound stream');
          }
        }

        await this.send({
          id: msg.data.message_id ?? '',
          channelId: this.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
          metadata: {
            channel: msg.data.slack_channel,
          },
          ...(attachments && attachments.length > 0 && { attachments }),
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
    logger.info({ channelId: this.channelId }, 'Slack adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const channel = (message.metadata?.['channel'] as string) ?? message.externalUserId;

    // If attachments present, send via files.upload for image files + text via chat.postMessage
    if (message.attachments && message.attachments.length > 0) {
      await this.sendWithAttachments(message, channel);
      return;
    }

    const payload = JSON.stringify({
      channel,
      text: message.content,
    });

    const url = new URL('https://slack.com/api/chat.postMessage');

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
              'Authorization': `Bearer ${this.botToken}`,
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
              try {
                const parsed = JSON.parse(body) as Record<string, unknown>;
                if (parsed['ok'] !== true) {
                  reject(new Error(`Slack API error: ${parsed['error'] ?? 'unknown'}`));
                } else {
                  resolve();
                }
              } catch {
                reject(new Error('Invalid JSON response from Slack API'));
              }
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Slack send failed');
      throw err;
    }
  }

  private async sendWithAttachments(message: ChannelMessage, channel: string): Promise<void> {
    const imageAttachments = message.attachments!.filter((a) => a.kind === 'image');

    // Send images via files.upload
    for (const att of imageAttachments) {
      try {
        const fileContent = att.bytes
          ? att.bytes.toString('base64')
          : att.url
            ? await this.downloadAsBase64(att.url)
            : undefined;

        if (!fileContent) {
          logger.warn({ filename: att.filename }, 'Slack attachment has no bytes or URL — skipping');
          continue;
        }

        const boundary = `----FormBoundary${Date.now()}`;
        const parts: Buffer[] = [];

        // Add file content
        parts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="file"; filename="${att.filename ?? 'image.png'}"${CRLF}` +
          `Content-Type: ${att.mime}${CRLF}${CRLF}`,
        ));
        parts.push(Buffer.from(fileContent, 'base64'));
        parts.push(Buffer.from(CRLF));

        // Add channels
        parts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="channels"${CRLF}${CRLF}` +
          `${channel}${CRLF}`,
        ));

        // Add initial comment (message text)
        if (message.content) {
          parts.push(Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="initial_comment"${CRLF}${CRLF}` +
            `${message.content}${CRLF}`,
          ));
        }

        parts.push(Buffer.from(`--${boundary}--${CRLF}`));

        const body = Buffer.concat(parts);

        await new Promise<void>((resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: 'slack.com',
              path: '/api/files.upload',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${this.botToken}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () => {
                const respBody = Buffer.concat(chunks).toString('utf8');
                try {
                  const parsed = JSON.parse(respBody) as Record<string, unknown>;
                  if (parsed['ok'] !== true) {
                    reject(new Error(`Slack files.upload error: ${parsed['error'] ?? 'unknown'}`));
                  } else {
                    resolve();
                  }
                } catch {
                  reject(new Error('Invalid JSON response from Slack files.upload'));
                }
              });
            },
          );
          req.on('error', reject);
          req.write(body);
          req.end();
        });
      } catch (err) {
        logger.warn({ err, filename: att.filename }, 'Failed to upload attachment to Slack, skipping');
      }
    }

    // Send non-image attachments as text links (graceful no-op for unsupported types)
    const nonImageAttachments = message.attachments!.filter((a) => a.kind !== 'image');
    if (nonImageAttachments.length > 0) {
      const links = nonImageAttachments
        .map((a) => a.url ?? `[${a.filename ?? a.kind}]`)
        .join('\n');
      const text = message.content ? `${message.content}\n${links}` : links;

      await this.send({
        ...message,
        content: text,
        attachments: undefined,
      });
    }
  }

  private async downloadAsBase64(url: string): Promise<string | undefined> {
    try {
      return await new Promise<string>((resolve, reject) => {
        const mod = url.startsWith('https') ? httpsRequest : httpRequest;
        const req = mod(url, { headers: { 'Authorization': `Bearer ${this.botToken}` } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        });
        req.on('error', reject);
        req.end();
      });
    } catch (err) {
      logger.warn({ err, url: url.slice(0, 80) }, 'Failed to download attachment');
      return undefined;
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
