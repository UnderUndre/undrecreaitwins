import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatService } from '@undrecreaitwins/core/services/chat-service.js';
import { ValidationError, NotFoundError } from '@undrecreaitwins/shared';

const chatService = new ChatService();

const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
    name: z.string().optional(),
  })).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
});

export const chatCompletionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/chat/completions', async (request, reply) => {
    const parseResult = chatCompletionSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    if (body.stream) {
      return handleStream(request as { tenantId: string }, reply, body);
    }

    return chatService.complete({
      tenantId: request.tenantId,
      personaSlug: body.model,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    });
  });
};

async function handleStream(
  request: { tenantId: string },
  reply: FastifyReply,
  body: z.infer<typeof chatCompletionSchema>,
): Promise<void> {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const response = await chatService.complete({
      tenantId: request.tenantId,
      personaSlug: body.model,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    });

    const content = response.choices[0]?.message?.content || '';
    const chunkId = response.id;
    const created = response.created;
    const model = response.model;

    const contentChunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: { role: 'assistant' as const, content },
        finish_reason: null,
      }],
    };
    reply.raw.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

    const doneChunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop' as const,
      }],
    };
    reply.raw.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    const errorPayload = error instanceof NotFoundError
      ? { error: { code: 'model_not_found', message: error.message } }
      : { error: { code: 'internal_error', message: 'Internal server error' } };
    reply.raw.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
  }

  reply.raw.end();
}
