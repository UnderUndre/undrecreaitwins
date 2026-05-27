import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { parseTelegramJson } from '../parsers/telegram-json.js';
import { parseWhatsappTxt } from '../parsers/whatsapp-txt.js';
import { parseGenericJsonl } from '../parsers/generic-jsonl.js';
import { extractTraits } from '../extractors/trait-extractor.js';
import type { TrainingSourceType } from '@undrecreaitwins/shared';
import { createStorageBackend } from '@undrecreaitwins/shared/storage.js';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { trainingJobs, personas } from '@undrecreaitwins/core/models/index.js';
import type { ParsedMessage } from '../parsers/telegram-json.js';
import type { TrainingJobData } from './queue.js';

export async function processTrainingJob(job: Job<TrainingJobData>): Promise<void> {
  const { tenantId, personaId, sourceType, sourceFileRef, jobId } = job.data;
  const storage = createStorageBackend();

  await withTenantContext(tenantId, async (tx) => {
    await tx
      .update(trainingJobs)
      .set({ status: 'running', startedAt: new Date(), progressPercent: 0 })
      .where(eq(trainingJobs.id, jobId));
  });

  try {
    await job.updateProgress(10);

    const messages: ParsedMessage[] = [];
    const parser = getParser(sourceType);
    for await (const msg of parser(sourceFileRef)) {
      messages.push(msg);
    }

    await job.updateProgress(50);

    if (messages.length === 0) {
      throw new Error('No messages found in training file');
    }

    const traits = extractTraits(messages);
    await job.updateProgress(80);

    await withTenantContext(tenantId, async (tx) => {
      const [persona] = await tx
        .select({ traits: personas.traits, version: personas.version })
        .from(personas)
        .where(eq(personas.id, personaId))
        .limit(1);
      const existing = (persona?.traits ?? {}) as Record<string, unknown>;
      const manualLock = Array.isArray(existing.manual_lock) ? (existing.manual_lock as string[]) : [];
      const merged: Record<string, unknown> = { ...traits };
      for (const key of manualLock) {
        if (key in existing) merged[key] = existing[key];
      }
      merged.manual_lock = manualLock;

      await tx
        .update(personas)
        .set({
          traits: merged,
          updatedAt: new Date(),
        })
        .where(eq(personas.id, personaId));

      await tx
        .update(trainingJobs)
        .set({
          status: 'completed',
          progressPercent: 100,
          extractedTraits: traits,
          completedAt: new Date(),
        })
        .where(eq(trainingJobs.id, jobId));
    });

    await job.updateProgress(100);
    job.returnvalue = { traits, messageCount: messages.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await withTenantContext(tenantId, async (tx) => {
      await tx
        .update(trainingJobs)
        .set({ status: 'failed', errorMessage: message, completedAt: new Date() })
        .where(eq(trainingJobs.id, jobId));
    });
    throw err;
  } finally {
    await storage.remove(sourceFileRef).catch(() => {});
  }
}

function getParser(sourceType: TrainingSourceType): (path: string) => AsyncGenerator<ParsedMessage> {
  switch (sourceType) {
    case 'telegram_json':
      return parseTelegramJson;
    case 'whatsapp_txt':
      return parseWhatsappTxt;
    case 'generic_jsonl':
      return parseGenericJsonl;
    default:
      throw new Error(`Unknown source type: ${sourceType}`);
  }
}
