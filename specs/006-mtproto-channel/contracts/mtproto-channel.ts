// specs/006-mtproto-channel/contracts/mtproto-channel.ts
//
// 006 implements the CANONICAL channel contract from @undrecreaitwins/shared.
// Do NOT invent a local adapter interface (codex F1). The adapter is a
// STANDALONE ChannelAdapter worker that bridges MTProto <-> the shared Redis
// Streams ChannelTransport — exactly like channel-telegram (Bot API) and
// channel-whatsapp.

import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelHealth,
} from '@undrecreaitwins/shared';
// ChannelTransport lives in @undrecreaitwins/core (services/channel-transport.ts) — Redis Streams.
import type { ChannelTransport } from '@undrecreaitwins/core';

/**
 * Resolves bearer secrets by handle at runtime. Raw apiHash / sessionString
 * MUST NOT live in broad option objects, be logged, or be serialized (codex F4).
 * Product owns storage (encrypted at rest) + rotation/revocation.
 */
export interface SecretResolver {
  /** Telegram app api_hash for this channel (never logged). */
  getApiHash(channelId: string): Promise<string>;
  /** Userbot session string — a bearer credential for a real account (never logged). */
  getSessionString(channelId: string): Promise<string>;
}

/** Inbound eligibility (codex F6). */
export interface AllowlistConfig {
  /** Allowed source chats/peers (normalized peer IDs or @usernames). */
  chats?: string[];
  /** Allowed senders; if set, the sender must match in ADDITION to the chat. */
  senders?: string[];
}

export interface MtprotoAdapterOptions {
  /** Canonical channel instance id — becomes ChannelMessage.channelId; binds session ↔ tenant/persona. */
  channelId: string;
  /** Telegram app id (the api_hash is resolved via `secrets`, never passed raw). */
  apiId: number;
  /** Secret-handle resolver — NO raw apiHash/sessionString in options (codex F4). */
  secrets: SecretResolver;
  /** Shared Redis Streams transport: publish INBOUND / consume OUTBOUND (codex F5). */
  transport: ChannelTransport;
  /** Inbound eligibility rules (codex F6). */
  allowlist?: AllowlistConfig;
  /** Typing refresh interval, ms (internal behaviour — NOT a contract method). Default 4000. */
  typingIntervalMs?: number;
}

/** Thrown when the session string is invalid/expired/revoked — no retry loop (codex F4). */
export declare class InvalidSessionError extends Error {}

/**
 * Standalone MTProto userbot adapter. Implements the SHARED ChannelAdapter
 * (no local interface). One worker process = one userbot session.
 *
 * MTProto → canonical ChannelMessage mapping (codex F1):
 *   id             = String(update.message.id)
 *   channelId      = opts.channelId
 *   externalUserId = normalized sender peer id
 *   content        = message text ('' / media handling per eligibility, codex F6)
 *   metadata       = { chatId, peerType, isOutgoing, isEdit, ... }
 *   timestamp      = new Date(update.message.date * 1000)
 *
 * Typing indication is INTERNAL (codex F8/§8): start on accepted inbound,
 * refresh every typingIntervalMs, stop on outbound send / timeout. NOT a method.
 */
export declare class TelegramMtprotoAdapter implements ChannelAdapter {
  constructor(opts: MtprotoAdapterOptions);
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void;
  send(message: ChannelMessage): Promise<void>;
  health(): Promise<ChannelHealth>;
}
