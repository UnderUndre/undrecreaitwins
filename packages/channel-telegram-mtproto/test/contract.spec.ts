import { describe, it, expect, vi } from 'vitest';
import { EligibilityFilter } from '../src/eligibility.js';
import { Api } from 'telegram';

describe('Contract & Eligibility', () => {
  const filter = new EligibilityFilter({
    chats: ['123456'],
    senders: ['987654']
  });

  it('should ignore outgoing messages (loop prevention)', () => {
    const msg = { out: true, message: 'hello', peerId: { userId: '123456' }, fromId: { userId: '987654' } } as any;
    expect(filter.isEligible(msg)).toBe(false);
  });

  it('should ignore service messages', () => {
    const msg = { out: false, action: {}, message: 'joined', peerId: { userId: '123456' }, fromId: { userId: '987654' } } as any;
    expect(filter.isEligible(msg)).toBe(false);
  });

  it('should ignore messages not in chat allowlist', () => {
    const msg = { out: false, message: 'hello', peerId: { userId: '999999' }, fromId: { userId: '987654' } } as any;
    expect(filter.isEligible(msg)).toBe(false);
  });

  it('should accept eligible messages', () => {
    const msg = { out: false, message: 'hello', peerId: { userId: '123456' }, fromId: { userId: '987654' } } as any;
    expect(filter.isEligible(msg)).toBe(true);
  });

  it('should normalize peer IDs correctly', () => {
    expect(filter.normalizePeerId({ userId: 123n })).toBe('123');
    expect(filter.normalizePeerId({ chatId: 456n })).toBe('456');
    expect(filter.normalizePeerId({ channelId: 789n })).toBe('789');
  });
});
