import type { Api } from 'telegram';
import type { AllowlistConfig } from './types.js';

export class EligibilityFilter {
  constructor(private readonly config?: AllowlistConfig) {}

  isEligible(message: Api.Message): boolean {
    // 1. Ignore outgoing messages (loop prevention, codex F6)
    if (message.out) return false;

    // 2. Ignore service messages (pins, join/leave)
    if (message.action) return false;

    // 3. Ignore empty/media-only messages if no text (per policy, codex F6)
    if (!message.message) return false;

    // 4. Check Allowlist (chats/peers)
    if (this.config?.chats && this.config.chats.length > 0) {
      const peerId = this.normalizePeerId(message.peerId);
      if (!this.config.chats.includes(peerId)) return false;
    }

    // 5. Check Allowlist (senders)
    if (this.config?.senders && this.config.senders.length > 0) {
      const senderId = this.normalizePeerId(message.fromId);
      if (!this.config.senders.includes(senderId)) return false;
    }

    return true;
  }

  normalizePeerId(peer: any): string {
    if (!peer) return '';
    if (typeof peer === 'string') return peer;
    if (peer.userId) return peer.userId.toString();
    if (peer.chatId) return peer.chatId.toString();
    if (peer.channelId) return peer.channelId.toString();
    return peer.toString();
  }
}
