import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus, ChannelAttachment } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import { request as httpsRequest } from 'node:https';

const logger = pino({ name: 'vk-adapter' });

const VK_API_BASE = 'https://api.vk.com/method/';
const VK_API_VERSION = '5.199';

interface VkLongPollServer {
  key: string;
  server: string;
  ts: string;
}

interface VkLongPollUpdate {
  type: string;
  object: Record<string, unknown>;
  event_id: string;
  v: string;
}

// --- VK attachment types ---

interface VkPhotoSize {
  type: string;
  url: string;
  width: number;
  height: number;
}

interface VkAttachment {
  type: string;
  photo?: { sizes: VkPhotoSize[] };
  doc?: { url: string; title?: string; ext?: string; type: number };
  audio?: { url: string; title?: string; artist?: string };
  video?: { player?: string; title?: string; first_frame?: Array<{ url: string }> };
  sticker?: { images?: Array<{ url: string }> };
  [key: string]: unknown;
}

function classifyVkAttachmentKind(att: VkAttachment): ChannelAttachment['kind'] {
  switch (att.type) {
    case 'photo':
    case 'sticker':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      return 'file';
  }
}

function extractVkAttachment(att: VkAttachment): ChannelAttachment | undefined {
  const kind = classifyVkAttachmentKind(att);

  switch (att.type) {
    case 'photo': {
      const sizes = att.photo?.sizes;
      if (!sizes || sizes.length === 0) return undefined;
      // Pick the largest size
      const best = sizes.reduce((prev, curr) =>
        (curr.width * (curr.height || 1)) > (prev.width * (prev.height || 1)) ? curr : prev,
      );
      return {
        kind,
        url: best.url,
        mime: 'image/jpeg',
        filename: 'photo.jpg',
      };
    }
    case 'sticker': {
      const images = att.sticker?.images;
      if (!images || images.length === 0) return undefined;
      return {
        kind,
        url: images[images.length - 1]!.url,
        mime: 'image/png',
        filename: 'sticker.png',
      };
    }
    case 'audio': {
      const url = att.audio?.url;
      if (!url) return undefined;
      return {
        kind,
        url,
        mime: 'audio/mpeg',
        filename: `${att.audio?.artist ?? 'unknown'} - ${att.audio?.title ?? 'audio'}.mp3`,
      };
    }
    case 'video': {
      // VK video URLs are complex (player embed) — extract first_frame if available
      const frame = att.video?.first_frame?.[0]?.url;
      const player = att.video?.player;
      return {
        kind,
        url: frame ?? player,
        mime: 'video/mp4',
        filename: `${att.video?.title ?? 'video'}.mp4`,
      };
    }
    case 'doc': {
      const url = att.doc?.url;
      if (!url) return undefined;
      // doc.type: 1=text, 2=archive, 3=gif, 4=image, 5=audio, 6=video, 7=ebook, 8=unknown
      const docMimes: Record<number, string> = {
        3: 'image/gif',
        4: 'image/png',
        5: 'audio/mpeg',
        6: 'video/mp4',
      };
      return {
        kind: docMimes[att.doc!.type]?.startsWith('image/') ? 'image'
          : docMimes[att.doc!.type]?.startsWith('audio/') ? 'audio'
          : docMimes[att.doc!.type]?.startsWith('video/') ? 'video'
          : 'file',
        url,
        mime: docMimes[att.doc!.type] ?? 'application/octet-stream',
        filename: att.doc?.title?.includes('.')
          ? att.doc.title
          : `${att.doc?.title ?? 'document'}.${att.doc?.ext ?? 'bin'}`,
      };
    }
    default:
      return undefined;
  }
}

function extractVkAttachments(attachments: VkAttachment[] | undefined): ChannelAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  const result: ChannelAttachment[] = [];
  for (const att of attachments) {
    const extracted = extractVkAttachment(att);
    if (extracted) result.push(extracted);
  }
  return result;
}

export class VkAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private accessToken: string;
  private groupId: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private longPollServer?: VkLongPollServer;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const accessToken = config.credentials['accessToken'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AppError('VK accessToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const groupId = config.credentials['groupId'];
    if (typeof groupId !== 'string' || groupId.length === 0) {
      throw new AppError('VK groupId is required (community/group bots only)', 400, 'INVALID_CREDENTIALS');
    }

    this.accessToken = accessToken;
    this.groupId = groupId;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
  }

  async connect(): Promise<void> {
    await this.getLongPollServer();
    this.startOutboundConsumer();
    this.running = true;
    this.poll();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId, groupId: this.groupId }, 'VK adapter connected');
  }

  private async getLongPollServer(): Promise<void> {
    const params = new URLSearchParams({
      access_token: this.accessToken,
      group_id: this.groupId,
      v: VK_API_VERSION,
    });

    const body = await this.vkApiCall('groups.getLongPollServer', params);
    const data = body as Record<string, unknown>;
    const response = data['response'] as VkLongPollServer | undefined;

    if (!response) {
      throw new AppError('Failed to get VK Long Poll server', 500, 'VK_LONG_POLL_ERROR');
    }

    this.longPollServer = response;
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.longPollServer) return;

    try {
      const server = this.longPollServer.server;
      const params = new URLSearchParams({
        act: 'a_check',
        key: this.longPollServer.key,
        ts: this.longPollServer.ts,
        wait: '25',
      });

      const body = await this.httpGet(`${server}?${params.toString()}`);
      const data = JSON.parse(body) as Record<string, unknown>;

      if (data['failed']) {
        logger.warn({ failed: data['failed'] }, 'VK Long Poll error, reconnecting');
        await this.getLongPollServer();
      } else {
        const ts = data['ts'] as string;
        const updates = data['updates'] as VkLongPollUpdate[] | undefined;

        if (ts && this.longPollServer) {
          this.longPollServer.ts = ts;
        }

        if (updates && updates.length > 0) {
          for (const update of updates) {
            await this.handleUpdate(update);
          }
        }
      }
    } catch (err) {
      logger.error({ err, channelId: this.channelId }, 'VK Long Poll error');
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), 1000);
    }
  }

  private async handleUpdate(update: VkLongPollUpdate): Promise<void> {
    if (update.type === 'message_new') {
      const msg = update.object as Record<string, unknown>;
      const messageData = msg['message'] as Record<string, unknown> | undefined;
      if (!messageData) return;

      // Ignore group messages (only handle direct messages to community)
      const fromId = messageData['from_id'] as number | undefined;
      if (!fromId || fromId < 0) return; // Negative = group, skip

      const text = (messageData['text'] as string) ?? '';
      const peerId = messageData['peer_id'] as number;
      const messageId = messageData['id'] as number;

      const vkAttachments = messageData['attachments'] as VkAttachment[] | undefined;
      const attachments = extractVkAttachments(vkAttachments);

      const message: ChannelMessage = {
        id: String(messageId),
        channelId: this.channelId,
        externalUserId: String(fromId),
        content: text,
        timestamp: new Date((messageData['date'] as number) * 1000),
        metadata: {
          peer_id: String(peerId),
          event_id: update.event_id,
        },
        ...(attachments.length > 0 && { attachments }),
      };

      const publishPayload: Record<string, string> = {
        channel_type: 'vk',
        channel_id: this.channelId,
        message_id: message.id,
        persona_slug: this.personaSlug,
        content: message.content,
        tenant_id: this.tenantId,
        external_user_id: message.externalUserId,
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
  }

  private startOutboundConsumer(): void {
    const consumerName = `vk-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-vk',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('vk', {
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
            peer_id: msg.data.vk_peer_id,
          },
          ...(attachments && attachments.length > 0 && { attachments }),
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'VK adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const peerId = (message.metadata?.['peer_id'] as string) ?? message.externalUserId;

    // VK supports sending photos via attachments parameter (owner_id_photo_id format)
    // For now, images as links in text; documents via docs.getMessagesUploadServer flow
    // Complex upload flows deferred — graceful no-op for channels without native media send
    let content = message.content;

    if (message.attachments && message.attachments.length > 0) {
      // Append attachment URLs as text for unsupported outbound media types
      const links = message.attachments
        .filter((a) => a.url)
        .map((a) => a.url)
        .join('\n');
      if (links.length > 0) {
        content = content ? `${content}\n${links}` : links;
      }
    }

    const params = new URLSearchParams({
      access_token: this.accessToken,
      v: VK_API_VERSION,
      peer_id: peerId,
      message: content,
      random_id: String(Math.floor(Math.random() * 2147483647)),
    });

    try {
      await this.vkApiCall('messages.send', params);
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'VK send failed');
      throw err;
    }
  }

  private async vkApiCall(method: string, params: URLSearchParams): Promise<unknown> {
    const url = `${VK_API_BASE}${method}`;
    const body = await this.httpPost(url, params.toString());

    const parsed = JSON.parse(body) as Record<string, unknown>;

    if (parsed['error']) {
      const errorMsg = (parsed['error'] as Record<string, unknown>)['error_msg'] ?? 'unknown VK API error';
      throw new Error(`VK API error: ${errorMsg}`);
    }

    return parsed;
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private httpPost(url: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const req = httpsRequest(
        {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
