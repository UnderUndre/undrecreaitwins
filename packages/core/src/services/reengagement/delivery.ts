import { db } from '../../db.js';
import { conversations, followupAttempts } from '../../models/index.js';
import { eq } from 'drizzle-orm';
import { ChannelTransport } from '../channel-transport.js';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';

const transport = new ChannelTransport();

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

    // 3. Construct payload
    const payload = {
      channel_id: convo.channelId || '',
      external_user_id: convo.externalUserId,
      content: lastMessage.content,
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
    await db.update(conversations)
      .set({
        lastReengagementAt: new Date(),
        reengagementCount: convo.reengagementCount + 1,
        // needsReengagement stays true for next cycle unless maxAttempts reached
      })
      .where(eq(conversations.id, convo.id));
  }
}
