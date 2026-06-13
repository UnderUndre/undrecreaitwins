import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { ChatService } from './chat-service.js';


const logger = pino({ name: 'fallback-worker' });
const chatService = new ChatService();

interface SoftFallbackPayload {
  tenantId: string;
  conversationId: string;
  channelMessageId: string;
  personaId: string;
  chatId: string;
  peerId: string;
}

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
};

/**
 * BullMQ worker for the `llm-fallback` queue.
 *
 * Processes delayed soft-fallback jobs. When the soft threshold expires
 * (e.g. 15s), this worker picks up the job, checks if the original LLM
 * response still hasn't arrived (delivery_records.state === 'pending'),
 * and if so, sends a fallback message via CAS.
 */
export function startFallbackWorker(): Worker<SoftFallbackPayload> {
  const worker = new Worker<SoftFallbackPayload>(
    'llm-fallback',
    async (job: Job<SoftFallbackPayload>) => {
      const { tenantId, conversationId, channelMessageId, personaId, chatId, peerId } = job.data;

      logger.info(
        { tenantId, conversationId, channelMessageId },
        'Soft fallback timer fired — checking delivery state',
      );

      // Load persona to get fallback messages
      const { PersonaRepository } = await import('./persona-repository.js');
      const personaRepo = new PersonaRepository();
      const persona = await personaRepo.getById(tenantId, personaId) as any;

      const fallbackMessages: string[] = persona?.fallbackMessages ?? [];
      if (!fallbackMessages.length) {
        logger.warn({ tenantId, personaId }, 'No fallback messages configured — skipping');
        return;
      }

      await chatService.executeSoftFallback(
        tenantId,
        conversationId,
        channelMessageId,
        personaId,
        chatId,
        peerId,
        fallbackMessages,
      );
    },
    {
      connection: REDIS_CONNECTION,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, tenantId: job?.data?.tenantId, err },
      'Soft fallback job failed',
    );
  });

  return worker;
}
