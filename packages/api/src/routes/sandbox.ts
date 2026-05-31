import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChatService } from '@undrecreaitwins/core/services/chat-service.js';
import { ValidationError } from '@undrecreaitwins/shared';

const chatService = new ChatService();

const sandboxChatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).min(1),
  temperature: z.number().min(0).max(2).optional(),
});

export const sandboxRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/v1/sandbox/chat', async (request) => {
    const parseResult = sandboxChatSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    // US3: Real reply path with isTestThread=true (FR-008)
    return chatService.complete({
      tenantId: request.tenantId,
      personaSlug: body.model,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: body.temperature,
      isTestThread: true,
      source: 'sandbox',
    });
  });
};
