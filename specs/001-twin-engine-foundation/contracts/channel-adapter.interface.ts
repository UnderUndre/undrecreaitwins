/**
 * Channel Adapter Interface
 *
 * Defines the contract that every channel adapter (Telegram, WhatsApp, etc.)
 * must implement. Adapters bridge external messaging platforms and the Twin Engine core.
 *
 * Lifecycle:
 *   1. Adapter is instantiated with channel-specific config.
 *   2. `connect()` establishes the connection to the provider.
 *   3. `onIncoming()` registers the handler for inbound messages.
 *   4. `send()` is called by the core to deliver outbound responses.
 *   5. `disconnect()` gracefully tears down the connection.
 *
 * Security:
 *   Adapters MUST validate incoming webhook signatures (e.g., Telegram secret_token,
 *   Evolution API webhook signature) before processing inbound messages.
 *   Unverified messages MUST be discarded.
 */

export interface ChannelMessage {
  id: string;
  channelId: string;
  externalUserId: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface ChannelHealth {
  status: "active" | "degraded" | "disconnected" | "error";
  lastPingAt?: Date;
  error?: string;
  uptimeSeconds?: number;
}

export interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void;
  send(message: ChannelMessage): Promise<void>;
  health(): Promise<ChannelHealth>;
}
