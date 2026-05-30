// specs/006-mtproto-channel/contracts/mtproto-channel.ts
export interface MTProtoChannelOptions {
  apiId: number;
  apiHash: string;
  sessionString: string;
  allowedChats?: (string | number)[];
  typingIntervalMs?: number;
}

export interface IChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<string>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  onMessage(handler: (msg: ChannelMessage) => void): void;
}

export interface ChannelMessage {
  id: string;
  chatId: string;
  text: string;
  senderId: string;
  timestamp: number;
}
