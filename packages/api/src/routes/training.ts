import type { FastifyPluginAsync } from 'fastify';
import { createStorageBackend } from '@undrecreaitwins/shared/storage.js';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { trainingJobs } from '@undrecreaitwins/core/models/index.js';
import { NotFoundError } from '@undrecreaitwins/shared';
import type { TrainingSourceType, PersonaTraits } from '@undrecreaitwins/shared';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { parseTelegramJson } from '@undrecreaitwins/training/parsers/telegram-json.js';
import { parseWhatsappTxt } from '@undrecreaitwins/training/parsers/whatsapp-txt.js';
import { parseGenericJsonl } from '@undrecreaitwins/training/parsers/generic-jsonl.js';
import { extractTraits } from '@undrecreaitwins/training/extractors/trait-extractor.js';
import type { ParsedMessage } from '@undrecreaitwins/training/parsers/telegram-json.js';

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

async function runTrainingPipeline(params: {
  sourceType: TrainingSourceType;
  sourceFileRef: string;
}): Promise<{ traits: PersonaTraits; messageCount: number }> {
  const messages: ParsedMessage[] = [];
  const parser = getParser(params.sourceType);
  for await (const msg of parser(params.sourceFileRef)) {
    messages.push(msg);
  }

  if (messages.length === 0) {
    throw new Error('No messages found in training file');
  }

  const traits = extractTraits(messages);
  return { traits, messageCount: messages.length };
}

function detectSourceType(filename?: string): TrainingSourceType {
  if (!filename) return 'generic_jsonl';
  if (filename.endsWith('.json')) return 'telegram_json';
  if (filename.endsWith('.txt')) return 'whatsapp_txt';
  if (filename.endsWith('.jsonl')) return 'generic_jsonl';
  return 'generic_jsonl';
}

function toApiJob(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    persona_id: row.personaId as string,
    tenant_id: row.tenantId as string,
    source_type: row.sourceType as string,
    status: row.status as string,
    progress_percent: row.progressPercent as number,
    extracted_traits: row.extractedTraits as PersonaTraits | null,
    error_message: (row.errorMessage as string | null) ?? null,
    started_at: (row.startedAt as Date | null)?.toISOString() ?? null,
    completed_at: (row.completedAt as Date | null)?.toISOString() ?? null,
    created_at: (row.createdAt as Date)?.toISOString(),
  };
}

export const trainingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/personas/:id/train', async (request, reply) => {
    const { id: personaId } = request.params as { id: string };
    const data = await request.file();
    if (!data) {
      throw new NotFoundError('Upload file');
    }

    const sourceTypeField = data.fields.source_type;
    const sourceTypeValue = sourceTypeField && !Array.isArray(sourceTypeField) && 'value' in sourceTypeField
      ? sourceTypeField.value as string
      : undefined;
    const sourceType = (sourceTypeValue as TrainingSourceType | undefined) ?? detectSourceType(data.filename);
    const buffer = await data.toBuffer();
    const storageKey = `${request.tenantId}/${personaId}/${randomUUID()}-${data.filename}`;
    const storage = createStorageBackend();
    const fileRef = await storage.save(storageKey, buffer);

    const jobId = randomUUID();
    await withTenantContext(request.tenantId, async (tx) => {
      await tx.insert(trainingJobs).values({
        id: jobId,
        tenantId: request.tenantId,
        personaId,
        sourceType,
        sourceFileRef: fileRef,
        status: 'running',
        startedAt: new Date(),
      });
    });

    runTrainingPipeline({ sourceType, sourceFileRef: fileRef })
      .then(async (result) => {
        await withTenantContext(request.tenantId, async (tx) => {
          await tx
            .update(trainingJobs)
            .set({
              status: 'completed',
              progressPercent: 100,
              extractedTraits: result.traits,
              completedAt: new Date(),
            })
            .where(eq(trainingJobs.id, jobId));
        });
      })
      .catch(async (err) => {
        await withTenantContext(request.tenantId, async (tx) => {
          await tx
            .update(trainingJobs)
            .set({
              status: 'failed',
              errorMessage: err instanceof Error ? err.message : 'Unknown error',
              completedAt: new Date(),
            })
            .where(eq(trainingJobs.id, jobId));
        });
      })
      .finally(async () => {
        await storage.remove(fileRef).catch(() => {});
      });

    reply.status(202);
    return { id: jobId, status: 'running', persona_id: personaId, tenant_id: request.tenantId };
  });

  fastify.get('/v1/training-jobs/:id', async (request) => {
    const { id } = request.params as { id: string };

    const rows = await withTenantContext(request.tenantId, async (tx) => {
      return tx
        .select()
        .from(trainingJobs)
        .where(and(eq(trainingJobs.id, id), eq(trainingJobs.tenantId, request.tenantId)))
        .limit(1);
    });

    const job = rows[0];
    if (!job) {
      throw new NotFoundError('Training job', id);
    }

    return toApiJob(job as unknown as Record<string, unknown>);
  });
};
