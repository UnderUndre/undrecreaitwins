import type { FastifyPluginAsync } from 'fastify';
import { createStorageBackend } from '@undrecreaitwins/shared/storage.js';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { trainingJobs } from '@undrecreaitwins/core/models/index.js';
import { NotFoundError, ValidationError } from '@undrecreaitwins/shared';
import type { TrainingSourceType, PersonaTraits } from '@undrecreaitwins/shared';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueTrainingJob } from '@undrecreaitwins/training/jobs/queue.js';

function sanitizeFilename(name: string): string {
  return name.replace(/\.\./g, '').replace(/[/\\]/g, '_');
}

function detectSourceType(filename?: string): TrainingSourceType {
  if (!filename) return 'generic_jsonl';
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return 'telegram_json';
  if (lower.endsWith('.txt')) return 'whatsapp_txt';
  if (lower.endsWith('.jsonl')) return 'generic_jsonl';
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
    const storageKey = `${request.tenantId}/${personaId}/${randomUUID()}-${sanitizeFilename(data.filename)}`;
    const storage = createStorageBackend();
    const fileRef = await storage.saveStream(storageKey, data.file);

    if (data.file.truncated) {
      await storage.remove(fileRef).catch(() => {});
      throw new ValidationError([
        {
          field: 'file',
          message: `Upload exceeds size limit of ${process.env.TWIN_MAX_UPLOAD_BYTES || '524288000'} bytes`,
        },
      ]);
    }

    const jobId = randomUUID();
    await withTenantContext(request.tenantId, async (tx) => {
      await tx.insert(trainingJobs).values({
        id: jobId,
        tenantId: request.tenantId,
        personaId,
        sourceType,
        sourceFileRef: fileRef,
        status: 'pending',
      });
    });

    try {
      await enqueueTrainingJob({
        jobId,
        tenantId: request.tenantId,
        personaId,
        sourceType,
        sourceFileRef: fileRef,
      });
    } catch (err) {
      await withTenantContext(request.tenantId, async (tx) => {
        await tx
          .update(trainingJobs)
          .set({
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : 'Failed to enqueue training job',
            completedAt: new Date(),
          })
          .where(eq(trainingJobs.id, jobId));
      });
      await storage.remove(fileRef).catch(() => {});
      throw err;
    }

    reply.status(202);
    return { id: jobId, status: 'pending', persona_id: personaId, tenant_id: request.tenantId };
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
