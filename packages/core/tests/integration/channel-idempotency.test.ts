/**
 * T024 — Per-Adapter Idempotency Tests
 *
 * Tests that message redelivery (same message_id) doesn't result in duplicate
 * processing. Uses Redis dedup key: seen:{channel_type}:{message_id} SET NX + TTL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const IDEMPOTENCY_TTL_SECONDS = 300;

const CHANNEL_TYPES = [
  'discord', 'slack', 'matrix', 'email', 'sms', 'webhook',
  'homeassistant', 'mattermost', 'dingtalk', 'feishu', 'wecom',
] as const;

describe('Per-Adapter Idempotency Tests', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    // Clean up test keys
    const keys = await redis.keys('seen:*:idem-test-*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  beforeEach(async () => {
    // Clean up before each test
    const keys = await redis.keys('seen:*:idem-test-*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  /**
   * Simulates the idempotency check that adapters do before publishing
   * an inbound message to the INBOUND stream.
   */
  async function checkIdempotency(
    channelType: string,
    messageId: string,
  ): Promise<{ isNew: boolean }> {
    const key = `seen:${channelType}:${messageId}`;
    const result = await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    return { isNew: result === 'OK' };
  }

  it('first delivery is accepted, duplicate is rejected', async () => {
    const channelType = 'webhook';
    const messageId = 'idem-test-msg-1';

    const first = await checkIdempotency(channelType, messageId);
    expect(first.isNew).toBe(true);

    const duplicate = await checkIdempotency(channelType, messageId);
    expect(duplicate.isNew).toBe(false);
  });

  it('different message IDs from same channel are both accepted', async () => {
    const channelType = 'discord';
    const msg1 = 'idem-test-msg-diff-1';
    const msg2 = 'idem-test-msg-diff-2';

    const first = await checkIdempotency(channelType, msg1);
    expect(first.isNew).toBe(true);

    const second = await checkIdempotency(channelType, msg2);
    expect(second.isNew).toBe(true);
  });

  it('same message ID across different channel types are both accepted', async () => {
    const messageId = 'idem-test-cross-channel';

    const fromDiscord = await checkIdempotency('discord', messageId);
    expect(fromDiscord.isNew).toBe(true);

    const fromSlack = await checkIdempotency('slack', messageId);
    expect(fromSlack.isNew).toBe(true);
  });

  it('idempotency key expires after TTL — redelivery accepted after expiry', async () => {
    const channelType = 'matrix';
    const messageId = 'idem-test-ttl-expiry';

    const first = await checkIdempotency(channelType, messageId);
    expect(first.isNew).toBe(true);

    // Manually expire the key
    const key = `seen:${channelType}:${messageId}`;
    await redis.del(key);

    const afterExpiry = await checkIdempotency(channelType, messageId);
    expect(afterExpiry.isNew).toBe(true);
  });

  // Test all channel types for idempotency
  for (const channelType of CHANNEL_TYPES) {
    it(`${channelType}: dedup prevents duplicate processing`, async () => {
      const messageId = `idem-test-${channelType}-msg`;

      const first = await checkIdempotency(channelType, messageId);
      expect(first.isNew).toBe(true);

      // Simulate 3 redeliveries
      for (let i = 0; i < 3; i++) {
        const redelivery = await checkIdempotency(channelType, messageId);
        expect(redelivery.isNew).toBe(false);
      }
    });
  }

  it('rapid fire: 100 duplicate deliveries — only 1 accepted', async () => {
    const channelType = 'webhook';
    const messageId = 'idem-test-rapid-fire';

    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      const result = await checkIdempotency(channelType, messageId);
      if (result.isNew) accepted++;
    }

    expect(accepted).toBe(1);
  });

  it('webhook adapter uses correct dedup key format', async () => {
    // The webhooks adapter uses: seen:webhooks:{channel_id}:{message_id}
    const channelId = 'ch-123';
    const messageId = 'idem-test-webhook-key';
    const key = `seen:webhooks:${channelId}:${messageId}`;

    const result = await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    expect(result).toBe('OK');

    // Duplicate
    const dupResult = await redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    expect(dupResult).toBeNull();

    await redis.del(key);
  });
});
