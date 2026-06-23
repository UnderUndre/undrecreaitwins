import { eq, and, sql, desc, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { tuningDrafts } from '../../models/index.js';
import { withTenantContext } from '../../db.js';
import { NotFoundError } from '@undrecreaitwins/shared';
import type { TuningDraftStatus, TuningMethod, ConfidenceLevel, ReviewVerdict } from '../../types/tuning.js';

type CreateTuningDraft = {
  personaId: string;
  method: TuningMethod;
  systemPrompt?: string;
  funnelConfig?: Record<string, unknown>;
  validatorToggles?: Record<string, boolean>;
  signals?: Record<string, unknown>;
  confidence?: ConfidenceLevel;
  error?: string;
};

type UpdateTuningDraft = {
  status?: TuningDraftStatus;
  confidence?: ConfidenceLevel;
  systemPrompt?: string;
  funnelConfig?: Record<string, unknown>;
  validatorToggles?: Record<string, boolean>;
  diffSections?: Record<string, unknown>;
  previousSnapshot?: Record<string, unknown>;
  signals?: Record<string, unknown>;
  error?: string;
  reviewVerdict?: ReviewVerdict;
  reviewNotes?: string;
  activatedAt?: Date;
};

type TuningDraftRow = typeof tuningDrafts.$inferSelect;

export class TuningDraftRepository {
  async create(tenantId: string, data: CreateTuningDraft): Promise<TuningDraftRow> {
    return withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .insert(tuningDrafts)
        .values({
          id: randomUUID(),
          tenantId,
          personaId: data.personaId,
          method: data.method,
          status: 'generating',
          systemPrompt: data.systemPrompt ?? null,
          funnelConfig: data.funnelConfig ?? null,
          validatorToggles: data.validatorToggles ?? null,
          signals: data.signals ?? null,
          confidence: data.confidence ?? null,
          error: data.error ?? null,
        })
        .returning();
      const draft = rows[0];
      if (!draft) {
        throw new Error('Insert returned no rows');
      }
      return draft;
    });
  }

  async getById(tenantId: string, draftId: string): Promise<TuningDraftRow> {
    return withTenantContext(tenantId, async (tx) => {
      const [draft] = await tx
        .select()
        .from(tuningDrafts)
        .where(eq(tuningDrafts.id, draftId))
        .limit(1);

      if (!draft) {
        throw new NotFoundError('TuningDraft', draftId);
      }

      if (draft.status === 'generating' && draft.createdAt < new Date(Date.now() - 90_000)) {
        const [updated] = await tx
          .update(tuningDrafts)
          .set({
            status: 'failed',
            error: 'GENERATION_STALLED',
            updatedAt: new Date(),
          })
          .where(eq(tuningDrafts.id, draftId))
          .returning();
        return updated ?? draft;
      }

      return draft;
    });
  }

  async listByPersona(
    tenantId: string,
    personaId: string,
    status?: TuningDraftStatus,
  ): Promise<TuningDraftRow[]> {
    return withTenantContext(tenantId, async (tx) => {
      const conditions = [eq(tuningDrafts.personaId, personaId)];
      if (status) {
        conditions.push(eq(tuningDrafts.status, status));
      }
      return tx
        .select()
        .from(tuningDrafts)
        .where(and(...conditions))
        .orderBy(desc(tuningDrafts.createdAt));
    });
  }

  async listByTenant(
    tenantId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ data: TuningDraftRow[]; total: number }> {
    return withTenantContext(tenantId, async (tx) => {
      const data = await tx
        .select()
        .from(tuningDrafts)
        .limit(limit)
        .offset(offset);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tuningDrafts);
      return { data, total: countRow?.count ?? 0 };
    });
  }

  async update(tenantId: string, draftId: string, data: UpdateTuningDraft): Promise<TuningDraftRow> {
    return withTenantContext(tenantId, async (tx) => {
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (data.status !== undefined) updateData.status = data.status;
      if (data.confidence !== undefined) updateData.confidence = data.confidence;
      if (data.systemPrompt !== undefined) updateData.systemPrompt = data.systemPrompt;
      if (data.funnelConfig !== undefined) updateData.funnelConfig = data.funnelConfig;
      if (data.validatorToggles !== undefined) updateData.validatorToggles = data.validatorToggles;
      if (data.diffSections !== undefined) updateData.diffSections = data.diffSections;
      if (data.previousSnapshot !== undefined) updateData.previousSnapshot = data.previousSnapshot;
      if (data.signals !== undefined) updateData.signals = data.signals;
      if (data.error !== undefined) updateData.error = data.error;
      if (data.reviewVerdict !== undefined) updateData.reviewVerdict = data.reviewVerdict;
      if (data.reviewNotes !== undefined) updateData.reviewNotes = data.reviewNotes;
      if (data.activatedAt !== undefined) updateData.activatedAt = data.activatedAt;

      const [updated] = await tx
        .update(tuningDrafts)
        .set(updateData)
        .where(eq(tuningDrafts.id, draftId))
        .returning();

      if (!updated && data.error === undefined) {
        throw new NotFoundError('TuningDraft', draftId);
      }
      return updated!;
    });
  }

  async getActiveDraft(personaId: string, tenantId: string): Promise<TuningDraftRow | null> {
    return withTenantContext(tenantId, async (tx) => {
      const [draft] = await tx
        .select()
        .from(tuningDrafts)
        .where(
          and(
            eq(tuningDrafts.personaId, personaId),
            eq(tuningDrafts.status, 'activated'),
            sql`${tuningDrafts.activatedAt} IS NOT NULL`,
          ),
        )
        .orderBy(desc(tuningDrafts.activatedAt))
        .limit(1);

      if (!draft) return null;

      const [newer] = await tx
        .select({ id: tuningDrafts.id })
        .from(tuningDrafts)
        .where(
          and(
            eq(tuningDrafts.personaId, personaId),
            eq(tuningDrafts.status, 'activated'),
            sql`${tuningDrafts.activatedAt} IS NOT NULL`,
            sql`${tuningDrafts.activatedAt} > ${draft.activatedAt}`,
          ),
        )
        .limit(1);

      if (newer) return null;

      return draft;
    });
  }

  async supersedeActiveDraft(personaId: string, tenantId: string): Promise<void> {
    return withTenantContext(tenantId, async (tx) => {
      await tx
        .update(tuningDrafts)
        .set({
          status: 'superseded',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tuningDrafts.personaId, personaId),
            eq(tuningDrafts.status, 'activated'),
          ),
        );
    });
  }

  async sweepStaleGenerating(
    personaIdOrNull: string | null,
    tenantId: string,
    thresholdMs: number,
  ): Promise<number> {
    return withTenantContext(tenantId, async (tx) => {
      const conditions: ReturnType<typeof eq>[] = [
        eq(tuningDrafts.status, 'generating'),
        lt(tuningDrafts.createdAt, new Date(Date.now() - thresholdMs)),
      ];

      if (personaIdOrNull) {
        conditions.push(eq(tuningDrafts.personaId, personaIdOrNull));
      }

      const result = await tx
        .update(tuningDrafts)
        .set({
          status: 'failed',
          error: 'GENERATION_STALLED',
          updatedAt: new Date(),
        })
        .where(and(...conditions));

      return result.count ?? 0;
    });
  }
}
