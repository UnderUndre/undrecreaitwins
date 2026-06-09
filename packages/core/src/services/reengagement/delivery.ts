import { db } from '../../db.js';
import { conversations, followupAttempts, followupRules } from '../../models/index.js';
import { eq } from 'drizzle-orm';
import { ChannelTransport } from '../channel-transport.js';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ValidatorPipeline } from '../validators/pipeline.js';
import { LLMClient } from '../llm-client.js';
import pino from 'pino';

const logger = pino({ name: 'reengagement-delivery' });
const transport = new ChannelTransport();
const validatorPipeline = new ValidatorPipeline(new LLMClient());

export class ReengagementDelivery {
  async deliver(attemptId: string): Promise<void> {
    // 1. Fetch attempt and conversation
    const [attempt] = await db.select()
      .from(followupAttempts)
      .where(eq(followupAttempts.id, attemptId))
      .limit(1);

    if (!attempt) throw new Error(`Attempt ${attemptId} not found`);

    const [convo] = await db.select()
      .from(conversations)
      .where(eq(conversations.id, attempt.conversationId))
      .limit(1);

    if (!convo) throw new Error(`Conversation ${attempt.conversationId} not found`);

    // 2. Load the generated message
    // We expect the generator to have persisted it as the last message
    const [lastMessage] = await db.query.messages.findMany({
      where: eq(conversations.id, convo.id),
      orderBy: (messages, { desc }) => [desc(messages.createdAt)],
      limit: 1
    });

    if (!lastMessage || lastMessage.role !== 'assistant') {
      throw new Error(`No assistant message found for conversation ${convo.id}`);
    }

    const validatedContent = await validatorPipeline.validateResponse(
      lastMessage.content,
      {
        tenantId: attempt.tenantId,
        personaId: convo.personaId,
        conversationId: convo.id,
        messageId: attempt.id,
      },
    );

    logger.info({ attemptId, conversationId: convo.id }, 'Reengagement content validated');

    const payload = {
      channel_id: convo.channelId || '',
      external_user_id: convo.externalUserId,
      content: validatedContent,
      tenant_id: attempt.tenantId,
      message_id: attempt.id,
      is_reengagement: 'true'
    };

    // 4. Publish to Redis
    await transport.publish(REDIS_STREAMS.OUTBOUND, payload);

    // 5. Update attempt status
    await db.update(followupAttempts)
      .set({
        status: 'sent',
        sentAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(followupAttempts.id, attemptId));
      
    // 6. Update conversation reengagement fields
    const newCount = convo.reengagementCount + 1;

    const [rule] = await db.select({ maxAttempts: followupRules.maxAttempts })
      .from(followupRules)
      .where(eq(followupRules.id, attempt.ruleId))
      .limit(1);

    const maxReached = rule ? newCount >= rule.maxAttempts : false;

    await db.update(conversations)
      .set({
        lastReengagementAt: new Date(),
        reengagementCount: newCount,
        needsReengagement: !maxReached,
      })
      .where(eq(conversations.id, convo.id));
  }
}
