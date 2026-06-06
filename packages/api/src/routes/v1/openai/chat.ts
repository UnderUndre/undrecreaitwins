import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatService } from '@undrecreaitwins/core/services/chat-service.js';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';

const chatService = new ChatService();
const personaRepo = new PersonaRepository();

const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
        name: z.string().optional(),
      }),
    )
    .min(1),
  stream: z.boolean().optional().default(false),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
});

type ChatCompletionBody = z.infer<typeof chatCompletionSchema>;

export const publicChatRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/chat/completions', async (request, reply) => {
    const parseResult = chatCompletionSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          message: parseResult.error.issues.map((i) => i.message).join('; '),
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      });
    }

    const body: ChatCompletionBody = parseResult.data;

    if (!body.model.startsWith('asst_')) {
      return reply.status(400).send({
        error: {
          message: 'model field must start with asst_',
          type: 'invalid_request_error',
          code: 'invalid_model',
        },
      });
    }

    const slug = body.model.slice(5);
    const tenantId = request.tenantId;
    const isTestThread = request.apiKeyMeta?.mode === 'test';

    try {
      await personaRepo.getBySlug(tenantId, slug);
    } catch {
      return reply.status(404).send({
        error: {
          message: `Model '${body.model}' not found`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
    }

    if (body.stream) {
      return handlePublicStream(request, reply, body, slug, isTestThread);
    }

    return chatService.complete({
      tenantId,
      personaSlug: slug,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      isTestThread,
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

async function handlePublicStream(
  request: any,
  reply: FastifyReply,
  body: ChatCompletionBody,
  slug: string,
  isTestThread: boolean,
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
      request.raw.off('drain', activeDrainListener);
      activeDrainListener = null;
    }
  };

  try {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    headersSent = true;

    const stream = chatService.completeStream({
      tenantId: request.tenantId,
      personaSlug: slug,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      isTestThread,
    });

    for await (const chunk of stream) {
      if (signal.aborted) break;

      const payload = `data: ${JSON.stringify(chunk)}\n\n`;
      await writePayloadWithBackpressure(payload, reply, signal, (l) => {
        activeDrainListener = l;
      });
    }

    if (!signal.aborted) {
      await writePayloadWithBackpressure('data: [DONE]\n\n', reply, signal, (l) => {
        activeDrainListener = l;
      });
    }
  } catch {
    if (!headersSent) {
      reply.status(500).send({
        error: { message: 'Internal server error', type: 'server_error', code: 'internal_error' },
      });
    }
  } finally {
    cleanupListeners();
    if (headersSent) {
      reply.raw.end();
    }
  }
}
