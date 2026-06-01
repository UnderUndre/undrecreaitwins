import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../core/src/db.js';
import { conversations, followupRules, followupAttempts, messages } from '../../../core/src/models/index.js';
import { ReengagementScanner } from '../../../core/src/services/reengagement/scanner.js';
import { ReengagementWorker } from '../../../core/src/services/reengagement/worker.js';
import { eq, sql } from 'drizzle-orm';

// Mock LLM and Redis
vi.mock('../../../core/src/services/llm-client.js', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    complete: vi.fn().mockResolvedValue({
      content: 'Hello from AI!',
      model: 'test-model',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finishReason: 'stop'
    })
  }))
}));

vi.mock('../../../core/src/services/channel-transport.js', () => ({
  ChannelTransport: vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockResolvedValue('msg-123')
  }))
}));

describe('Re-engagement Integration', () => {
  const scanner = new ReengagementScanner();
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    // Clean up
    await db.delete(followupAttempts);
    await db.delete(followupRules);
    await db.delete(messages);
    await db.delete(conversations);
  });

  it('should scan, schedule, and process a re-engagement hook', async () => {
    // 1. Setup Rule
    const [rule] = await db.insert(followupRules).values({
      tenantId,
      triggerStaleMinutes: 30,
      backoff: [1440],
      maxAttempts: 3,
      template: 'Win back prompt',
      isActive: true,
      conditions: {}
    }).returning();

    // 2. Setup Conversation (Dormant)
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000);
    const [convo] = await db.insert(conversations).values({
      tenantId,
      personaId: '00000000-0000-0000-0000-000000000002',
      externalUserId: 'test-user',
      status: 'active',
      lastMessageAt: thirtyOneMinutesAgo,
      needsReengagement: true,
      reengagementCount: 0
    }).returning();

    // 3. Run Scanner
    await scanner.runScan(tenantId);

    // 4. Verify Attempt Scheduled
    const attempts = await db.select().from(followupAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('scheduled');
    expect(attempts[0].conversationId).toBe(convo.id);
    expect(attempts[0].ruleId).toBe(rule.id);

    // 5. Run Worker Logic (manually trigger the batch processing)
    const worker = new ReengagementWorker();
    // @ts-ignore - access private for test
    await worker.processScheduledAttempts();

    // 6. Verify Attempt Sent
    const updatedAttempts = await db.select().from(followupAttempts).where(eq(followupAttempts.id, attempts[0].id));
    expect(updatedAttempts[0].status).toBe('sent');
    expect(updatedAttempts[0].sentAt).toBeDefined();

    // 7. Verify Conversation Updated
    const updatedConvo = await db.select().from(conversations).where(eq(conversations.id, convo.id));
    expect(updatedConvo[0].reengagementCount).toBe(1);
    expect(updatedConvo[0].lastReengagementAt).toBeDefined();

    // 8. Verify Message Persisted
    const convoMessages = await db.select().from(messages).where(eq(messages.conversationId, convo.id));
    expect(convoMessages).toHaveLength(1);
    expect(convoMessages[0].content).toBe('Hello from AI!');
    
    await worker.close();
  });

  it('should honor opt-out', async () => {
    await db.insert(followupRules).values({
      tenantId,
      triggerStaleMinutes: 1,
      template: 'Prompt',
      isActive: true
    });

    await db.insert(conversations).values({
      tenantId,
      personaId: '00000000-0000-0000-0000-000000000002',
      externalUserId: 'opt-out-user',
      status: 'active',
      lastMessageAt: new Date(Date.now() - 5 * 60 * 1000),
      needsReengagement: true,
      optedOut: true
    });

    await scanner.runScan(tenantId);

    const attempts = await db.select().from(followupAttempts);
    expect(attempts).toHaveLength(0);
  });
});
