import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import nodemailer from 'nodemailer';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';

const logger = pino({ name: 'email-adapter' });

interface EmailCredentials {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
}

function parseCredentials(raw: Record<string, unknown>): EmailCredentials {
  const imapHost = raw['imapHost'];
  const imapUser = raw['imapUser'];
  const imapPass = raw['imapPass'];
  const smtpHost = raw['smtpHost'];
  const smtpUser = raw['smtpUser'];
  const smtpPass = raw['smtpPass'];

  if (typeof imapHost !== 'string' || imapHost.length === 0) {
    throw new AppError('Email imapHost is required in credentials', 400, 'INVALID_CREDENTIALS');
  }
  if (typeof imapUser !== 'string' || imapUser.length === 0) {
    throw new AppError('Email imapUser is required in credentials', 400, 'INVALID_CREDENTIALS');
  }
  if (typeof imapPass !== 'string' || imapPass.length === 0) {
    throw new AppError('Email imapPass is required in credentials', 400, 'INVALID_CREDENTIALS');
  }
  if (typeof smtpHost !== 'string' || smtpHost.length === 0) {
    throw new AppError('Email smtpHost is required in credentials', 400, 'INVALID_CREDENTIALS');
  }
  if (typeof smtpUser !== 'string' || smtpUser.length === 0) {
    throw new AppError('Email smtpUser is required in credentials', 400, 'INVALID_CREDENTIALS');
  }
  if (typeof smtpPass !== 'string' || smtpPass.length === 0) {
    throw new AppError('Email smtpPass is required in credentials', 400, 'INVALID_CREDENTIALS');
  }

  return {
    imapHost,
    imapPort: typeof raw['imapPort'] === 'number' ? raw['imapPort'] : 993,
    imapUser,
    imapPass,
    smtpHost,
    smtpPort: typeof raw['smtpPort'] === 'number' ? raw['smtpPort'] : 587,
    smtpUser,
    smtpPass,
    fromAddress: typeof raw['fromAddress'] === 'string' ? raw['fromAddress'] : smtpUser,
  };
}

export class EmailAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private credentials: EmailCredentials;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;

  private smtpTransport: nodemailer.Transporter;
  private imapClient: ImapFlow;
  private lastPingAt?: Date;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    this.credentials = parseCredentials(config.credentials);
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;

    // Create SMTP transport
    this.smtpTransport = nodemailer.createTransport({
      host: this.credentials.smtpHost,
      port: this.credentials.smtpPort,
      secure: this.credentials.smtpPort === 465,
      auth: {
        user: this.credentials.smtpUser,
        pass: this.credentials.smtpPass,
      },
    });

    // Create IMAP client config
    const imapOptions: ImapFlowOptions = {
      host: this.credentials.imapHost,
      port: this.credentials.imapPort,
      secure: this.credentials.imapPort === 993,
      auth: {
        user: this.credentials.imapUser,
        pass: this.credentials.imapPass,
      },
      logger: false,
    };
    this.imapClient = new ImapFlow(imapOptions);
  }

  async connect(): Promise<void> {
    // Connect IMAP
    try {
      await this.imapClient.connect();
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Failed to connect IMAP client');
      throw new AppError('IMAP connection failed', 502, 'IMAP_CONNECTION_ERROR');
    }

    // Verify SMTP transport
    try {
      await this.smtpTransport.verify();
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Failed to verify SMTP transport');
      throw new AppError('SMTP verification failed', 502, 'SMTP_CONNECTION_ERROR');
    }

    // Lock INBOX and start idle listener for new messages
    this.startImapIdle().catch((err) => {
      logger.error({ err, channelId: this.channelId }, 'IMAP idle loop exited with error');
      this._status = 'error';
    });

    this.startOutboundConsumer();
    this._status = 'active';
    this.lastPingAt = new Date();
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Email adapter connected');
  }

  private async startImapIdle(): Promise<void> {
    // Acquire lock only for initial fetch, release BEFORE entering idle
    let lock;
    try {
      lock = await this.imapClient.getMailboxLock('INBOX');
      await this.fetchAndProcessUnseen();
    } finally {
      lock?.release();
    }

    // Set up event-driven new message detection (each fetch acquires/releases its own lock)
    this.imapClient.on('exists', async (data) => {
      if (data.path === 'INBOX') {
        logger.debug({ channelId: this.channelId, count: data.count }, 'IMAP exists event received');
        await this.fetchWithLock();
      }
    });

    this.imapClient.on('error', (err) => {
      logger.error({ err, channelId: this.channelId }, 'IMAP client error');
      this._status = 'error';
    });

    // Enter idle OUTSIDE the lock — prevents deadlock on disconnect/logout
    await this.imapClient.idle();
  }

  private async fetchWithLock(): Promise<void> {
    let lock;
    try {
      lock = await this.imapClient.getMailboxLock('INBOX');
      await this.fetchAndProcessUnseen();
    } catch (err) {
      logger.error({ err, channelId: this.channelId }, 'Failed to fetch with lock');
    } finally {
      lock?.release();
    }
  }

  private async fetchAndProcessUnseen(): Promise<void> {
    try {
      const messageGenerator = this.imapClient.fetch('unseen', {
        envelope: true,
        source: true,
        flags: true,
      });

      for await (const msg of messageGenerator) {
        try {
          await this.handleImapMessage(msg);
        } catch (err) {
          logger.error({ err, channelId: this.channelId, uid: msg.uid }, 'Failed to process IMAP message');
        }
      }
    } catch (err) {
      logger.error({ err, channelId: this.channelId }, 'Failed to fetch unseen messages');
    }
  }

  private async handleImapMessage(msg: {
    uid?: number;
    envelope?: {
      messageId?: string;
      from?: Array<{ address?: string; name?: string }>;
      subject?: string;
      date?: Date;
    };
    source?: Buffer;
  }): Promise<void> {
    const messageId = msg.envelope?.messageId ?? `imap-${msg.uid ?? Date.now()}`;
    const fromAddress = msg.envelope?.from?.[0]?.address ?? 'unknown@unknown';
    const subject = msg.envelope?.subject ?? '(no subject)';
    const bodyText = await this.extractTextBody(msg.source);

    const content = subject.length > 0 ? `${subject}\n\n${bodyText}` : bodyText;

    const message: ChannelMessage = {
      id: messageId,
      channelId: this.channelId,
      externalUserId: fromAddress,
      content,
      timestamp: msg.envelope?.date ?? new Date(),
      metadata: {
        subject,
        fromAddress,
        imapUid: msg.uid,
      },
    };

    const publishPayload: Record<string, string> = {
      channel_type: 'email',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: message.externalUserId,
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, publishPayload);

    if (this.incomingHandler) {
      await this.incomingHandler(message);
    }
  }

  private async extractTextBody(source: Buffer | undefined): Promise<string> {
    if (!source) return '';

    try {
      const parsed = await simpleParser(source);
      const text = parsed.text ?? '';
      if (text.length > 0) return text.trim();
    } catch (err) {
      logger.debug({ err, channelId: this.channelId }, 'mailparser failed, falling back to raw extraction');
    }

    const raw = source.toString('utf-8');
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      return raw.substring(headerEnd + 4).trim();
    }

    return raw.trim();
  }

  private startOutboundConsumer(): void {
    const consumerName = `email-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-email',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('email', {
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
    ).catch((err: unknown) => {
      logger.error({ err, channelId: this.channelId }, 'Outbound consumer failed');
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    try {
      await this.imapClient.logout();
    } catch (err) {
      logger.warn({ err, channelId: this.channelId }, 'Error closing IMAP connection');
    }

    try {
      this.smtpTransport.close();
    } catch (err) {
      logger.warn({ err, channelId: this.channelId }, 'Error closing SMTP transport');
    }

    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Email adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const toAddress = message.externalUserId;
    if (!toAddress || toAddress === 'unknown@unknown') {
      logger.warn({ channelId: this.channelId }, 'Cannot send email: no valid recipient address');
      return;
    }

    // Use metadata subject if replying to a thread
    const subject = message.metadata?.['subject'] as string | undefined;
    const replySubject = subject
      ? (subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`)
      : '(no subject)';

    try {
      const result = await this.smtpTransport.sendMail({
        from: this.credentials.fromAddress,
        to: toAddress,
        subject: replySubject,
        text: message.content,
        messageId: message.id ? `<${message.id}@${this.credentials.smtpHost}>` : undefined,
      });

      this.lastPingAt = new Date();
      logger.info({ channelId: this.channelId, to: toAddress, messageId: result.messageId }, 'Email sent');
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId, to: toAddress }, 'Email send failed');
      throw err;
    }
  }

  async health(): Promise<ChannelHealth> {
    const isImapConnected = this.imapClient.usable ?? false;
    let status: ChannelStatus = this._status;
    if (status === 'active' && !isImapConnected) {
      status = 'degraded';
    }

    return {
      status,
      uptimeSeconds: process.uptime(),
      lastPingAt: this.lastPingAt,
    };
  }
}
