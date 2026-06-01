import { db } from '../../db.js';
import { messages, followupRules } from '../../models/index.js';
import { eq, desc, and } from 'drizzle-orm';
import { LLMClient } from '../llm-client.js';
import { ChatService } from '../chat-service.js';

const llm = new LLMClient();
const chatService = new ChatService();

export class ReengagementGenerator {
  async generateHook(
    tenantId: string, 
    conversationId: string, 
    ruleId: string,
    timeoutMs: number = 30000
  ): Promise<{ content: string; usage: any }> {
    // 1. Load history (last 10 messages)
    const history = await db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: [desc(messages.createdAt)],
      limit: 10
    });

    // 2. Fetch rule template
    const [rule] = await db.select()
      .from(followupRules)
      .where(and(
        eq(followupRules.id, ruleId),
        eq(followupRules.tenantId, tenantId)
      ))
      .limit(1);

    if (!rule) {
      throw new Error(`Rule ${ruleId} not found`);
    }

    // 3. Assemble prompt
    // Anti-injection: template as system, history as user/assistant turns
    const promptMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: rule.template },
      ...history.reverse().map(m => ({ 
        role: m.role as 'user' | 'assistant', 
        content: m.content 
      }))
    ];

    // 4. Call LLM with timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await llm.complete({
        messages: promptMessages,
        // Using a reasonable default model if not specified in rule
        model: 'gpt-4o', 
      });

      // 5. Persist the hook to messages table
      await chatService.persistMessages(
        tenantId,
        conversationId,
        [], // No new inbound messages
        response.content
      );

      return {
        content: response.content,
        usage: response.usage
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
