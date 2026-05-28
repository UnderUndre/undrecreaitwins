import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatService } from '@undrecreaitwins/core/services/chat-service.js';
import { ValidationError } from '@undrecreaitwins/shared';

const chatService = new ChatService();

const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
    name: z.string().optional(),
  })).min(1),
  stream: z.boolean().optional().default(false),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).optional(),
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
      return handleStream(request as { tenantId: string; raw: any }, reply, body);
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

function writePayloadWithBackpressure(
  payload: string,
  reply: FastifyReply,
  signal: AbortSignal,
  setActiveDrainListener: (listener: (() => void) | null) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const ok = reply.raw.write(payload);
    if (ok) {
      resolve();
      return;
    }

    const onDrain = () => {
      signal.removeEventListener('abort', onAbort);
      setActiveDrainListener(null);
      resolve();
    };

    const onAbort = () => {
      reply.raw.off('drain', onDrain);
      setActiveDrainListener(null);
      resolve();
    };

    setActiveDrainListener(onDrain);
    reply.raw.once('drain', onDrain);
    signal.addEventListener('abort', onAbort);
  });
}

async function handleStream(
  request: { tenantId: string; raw: any },
  reply: FastifyReply,
  body: z.infer<typeof chatCompletionSchema>,
): Promise<void> {
  const abortController = new AbortController();
  const signal = abortController.signal;

  const onClientDisconnect = () => {
    abortController.abort(new Error('client_disconnect'));
  };

  request.raw.on('close', onClientDisconnect);

  let headersSent = false;
  let activeDrainListener: (() => void) | null = null;

  const cleanupListeners = () => {
    request.raw.off('close', onClientDisconnect);
    if (activeDrainListener) {
      reply.raw.off('drain', activeDrainListener);
      activeDrainListener = null;
    }
  };

  const startTime = Date.now();

  try {
    const generator = chatService.completeStream(
      {
        tenantId: request.tenantId,
        personaSlug: body.model,
        messages: body.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        streamOptions: body.stream_options,
      },
      signal,
    );

    while (true) {
      const nextResult = await generator.next();
      if (nextResult.done) {
        const result = nextResult.value;
        cleanupListeners();

        if (result && result.completed && result.conversationId && result.personaId) {
          const latencyMs = Date.now() - startTime;
          await chatService.persistMessages(
            request.tenantId,
            result.conversationId,
            body.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            result.content,
          );

          await chatService.emitUsageEvent(
            request.tenantId,
            result.personaId,
            result.conversationId,
            body.model,
            result.usage || { prompt_tokens: 0, completion_tokens: 0 },
            latencyMs,
          );
        }
        break;
      }

      const chunk = nextResult.value;

      if (signal.aborted) {
        break;
      }

      if (!headersSent) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        headersSent = true;
      }

      const payload = `data: ${JSON.stringify(chunk)}\n\n`;
      const payloadBytes = Buffer.byteLength(payload, 'utf8');

      if (payloadBytes > 16384) {
        const choices = chunk.choices || [];
        if (choices.length > 0 && choices[0]?.delta?.content) {
          const originalContent = choices[0].delta.content;
          const chunkId = chunk.id;
          const created = chunk.created;
          const modelName = chunk.model;
          const index = choices[0].index;
          const finishReason = choices[0].finish_reason;

          const maxContentBytes = 12000;
          const parts: string[] = [];
          let currentPart = '';
          let currentBytes = 0;

          for (const char of originalContent) {
            const charBytes = Buffer.byteLength(char, 'utf8');
            if (currentBytes + charBytes > maxContentBytes) {
              parts.push(currentPart);
              currentPart = char;
              currentBytes = charBytes;
            } else {
              currentPart += char;
              currentBytes += charBytes;
            }
          }
          if (currentPart) {
            parts.push(currentPart);
          }

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            const isLast = i === parts.length - 1;
            const subChunk = {
              id: chunkId,
              object: 'chat.completion.chunk' as const,
              created,
              model: modelName,
              choices: [{
                index,
                delta: {
                  ...(choices[0].delta.role && { role: choices[0].delta.role }),
                  content: part,
                },
                finish_reason: isLast ? finishReason : null,
              }],
              ...(isLast && chunk.usage && { usage: chunk.usage }),
            };
            const subPayload = `data: ${JSON.stringify(subChunk)}\n\n`;
            await writePayloadWithBackpressure(subPayload, reply, signal, (listener) => {
              activeDrainListener = listener;
            });
          }
        } else {
          await writePayloadWithBackpressure(payload, reply, signal, (listener) => {
            activeDrainListener = listener;
          });
        }
      } else {
        await writePayloadWithBackpressure(payload, reply, signal, (listener) => {
          activeDrainListener = listener;
        });
      }
    }

    if (signal.aborted) {
      cleanupListeners();
      reply.raw.end();
      return;
    }

    if (!headersSent) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  } catch (error: any) {
    cleanupListeners();

    const isAppError = error && typeof error === 'object' && 'statusCode' in error && 'code' in error;
    const errorCode = isAppError ? error.code : 'internal_error';
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const statusCode = isAppError ? error.statusCode : 500;

    const errorPayload = {
      error: {
        code: errorCode,
        message: errorMessage,
      },
    };

    if (!headersSent) {
      reply.raw.writeHead(statusCode, {
        'Content-Type': 'application/json',
      });
      reply.raw.write(JSON.stringify(errorPayload));
    } else {
      reply.raw.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
    }
    reply.raw.end();
  }
}
