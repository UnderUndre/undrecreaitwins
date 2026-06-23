import { eq, and, sql, isNull } from 'drizzle-orm';
import { withTenantContext } from '../../db.js';
import {
  tuningDrafts,
  personas,
  funnelDefinitions,
  funnelVersions,
  funnelStages,
  funnelSlots,
  validatorConfigs,
} from '../../models/index.js';
import { TuningDraftRepository } from './tuning-draft-repository.js';
import { FunnelConfigMapper } from './funnel-config-mapper.js';
import { ConflictError, NotFoundError } from '@undrecreaitwins/shared';
import type { PreviousSnapshot } from '../../types/tuning.js';

const draftRepo = new TuningDraftRepository();
const funnelMapper = new FunnelConfigMapper();

export class ActivatePipeline {
  async activate(draftId: string, tenantId: string): Promise<{ activatedAt: string }> {
    const draft = await draftRepo.getById(tenantId, draftId);
    if (draft.status !== 'ready') {
      if (draft.status === 'activated') {
        throw new ConflictError('Draft is already activated');
      }
      throw new ConflictError(`Cannot activate draft with status: ${draft.status}`);
    }

    return withTenantContext(tenantId, async (tx) => {
      const [persona] = await tx
        .select()
        .from(personas)
        .where(eq(personas.id, draft.personaId))
        .limit(1);
      if (!persona) throw new NotFoundError('Persona', draft.personaId);

      const validators = await tx
        .select()
        .from(validatorConfigs)
        .where(eq(validatorConfigs.personaId, draft.personaId));

      const priorValidatorToggles: Record<string, boolean> = {};
      for (const v of validators) {
        const cfg = v.config as any;
        priorValidatorToggles[v.validatorName] = cfg?.enabled !== false;
      }

      const [activeDef] = await tx
        .select()
        .from(funnelDefinitions)
        .where(and(
          eq(funnelDefinitions.tenantId, tenantId),
          eq(funnelDefinitions.personaId, draft.personaId),
          isNull(funnelDefinitions.deletedAt),
        ))
        .limit(1);

      let priorFunnelVersionId: string | null = null;
      if (activeDef) {
        const [activeVer] = await tx
          .select({ id: funnelVersions.id })
          .from(funnelVersions)
          .where(and(
            eq(funnelVersions.definitionId, activeDef.id),
            eq(funnelVersions.isActive, true),
          ))
          .limit(1);
        priorFunnelVersionId = activeVer?.id || null;
      }

      const previousSnapshot: PreviousSnapshot = {
        systemPrompt: persona.systemPrompt,
        traits: persona.traits as Record<string, unknown>,
        priorFunnelVersionId,
        priorValidatorToggles,
      };

      await tx
        .update(tuningDrafts)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(
          eq(tuningDrafts.personaId, draft.personaId),
          eq(tuningDrafts.status, 'activated'),
        ));

      if (draft.systemPrompt) {
        await tx
          .update(personas)
          .set({
            systemPrompt: draft.systemPrompt,
            updatedAt: new Date(),
            version: sql`${personas.version} + 1`,
          })
          .where(eq(personas.id, draft.personaId));
      }

      let funnelVersionId: string | null = null;
      if (draft.funnelConfig) {
        const mapped = await funnelMapper.mapToVersion(
          tenantId, draft.personaId, draft.funnelConfig as any,
        );
        if (mapped) {
          let defId: string;
          if (activeDef) {
            defId = activeDef.id;
          } else {
            const [newDef] = await tx
              .insert(funnelDefinitions)
              .values({
                tenantId,
                personaId: draft.personaId,
                name: `Tuning: ${draft.personaId.slice(0, 8)}`,
              })
              .returning({ id: funnelDefinitions.id });
            if (!newDef) throw new Error('Failed to create funnel definition');
            defId = newDef.id;
          }

          const [lastVer] = await tx
            .select({ maxVersion: sql<number>`coalesce(max(${funnelVersions.versionNumber}), 0)` })
            .from(funnelVersions)
            .where(eq(funnelVersions.definitionId, defId));
          const nextNumber = (lastVer?.maxVersion ?? 0) + 1;

          await tx
            .update(funnelVersions)
            .set({ isActive: false })
            .where(eq(funnelVersions.definitionId, defId));

          const [fv] = await tx
            .insert(funnelVersions)
            .values({
              definitionId: defId,
              versionNumber: nextNumber,
              config: draft.funnelConfig as any,
              isActive: true,
            })
            .returning({ id: funnelVersions.id });
          if (!fv) throw new Error('Failed to create funnel version');
          funnelVersionId = fv.id;

          for (let i = 0; i < mapped.stages.length; i++) {
            const stage = mapped.stages[i]!;
            const [insertedStage] = await tx
              .insert(funnelStages)
              .values({
                funnelVersionId,
                name: stage.name,
                order: i + 1,
                objective: stage.description || null,
                resolutionCriteria: { type: 'all_slots_filled' },
                requiredSlots: [],
                requiresConfirmation: false,
                isAnytime: false,
              })
              .returning({ id: funnelStages.id });
            if (!insertedStage) throw new Error('Failed to create funnel stage');

            const stageInput = (draft.funnelConfig as any)?.funnelStages?.[i];
            if (stageInput?.slots?.length > 0) {
              await tx.insert(funnelSlots).values(
                stageInput.slots.map((s: any) => ({
                  funnelVersionId,
                  stageId: insertedStage.id,
                  name: s.name,
                  description: s.question || null,
                  locked: false,
                }))
              );
            }
          }
        }
      }

      if (draft.validatorToggles) {
        const toggles = draft.validatorToggles as Record<string, boolean>;
        for (const [name, enabled] of Object.entries(toggles)) {
          await tx
            .update(validatorConfigs)
            .set({
              config: sql`jsonb_set(coalesce(${validatorConfigs.config}, '{}'::jsonb), '{enabled}', ${enabled ? 'true' : 'false'}::jsonb)`,
              updatedAt: new Date(),
            })
            .where(and(
              eq(validatorConfigs.personaId, draft.personaId),
              eq(validatorConfigs.validatorName, name),
            ));
        }
      }

      const diffSections = {
        systemPromptChanged: draft.systemPrompt !== null,
        funnelConfigChanged: draft.funnelConfig !== null,
        validatorTogglesChanged: draft.validatorToggles !== null,
      };

      const now = new Date();
      await tx
        .update(tuningDrafts)
        .set({
          status: 'activated',
          previousSnapshot: previousSnapshot as any,
          diffSections: diffSections as any,
          activatedAt: now,
          updatedAt: now,
        })
        .where(eq(tuningDrafts.id, draftId));

      return { activatedAt: now.toISOString() };
    });
  }

  async rollback(draftId: string, tenantId: string): Promise<void> {
    return withTenantContext(tenantId, async (tx) => {
      const [draft] = await tx
        .select()
        .from(tuningDrafts)
        .where(eq(tuningDrafts.id, draftId))
        .limit(1);
      if (!draft) throw new NotFoundError('TuningDraft', draftId);

      if (draft.status === 'superseded') {
        throw new ConflictError('DRAFT_SUPERSEDED');
      }
      if (draft.status !== 'activated') {
        throw new ConflictError(`Cannot rollback draft with status: ${draft.status}`);
      }

      const snapshot = draft.previousSnapshot as PreviousSnapshot | null;
      if (!snapshot) {
        throw new ConflictError('NO_PREVIOUS_SNAPSHOT');
      }

      await tx
        .update(personas)
        .set({
          systemPrompt: snapshot.systemPrompt,
          traits: snapshot.traits as any,
          updatedAt: new Date(),
          version: sql`${personas.version} + 1`,
        })
        .where(eq(personas.id, draft.personaId));

      if (snapshot.priorFunnelVersionId) {
        const [def] = await tx
          .select({ id: funnelDefinitions.id })
          .from(funnelDefinitions)
          .where(and(
            eq(funnelDefinitions.personaId, draft.personaId),
            isNull(funnelDefinitions.deletedAt),
          ))
          .limit(1);

        if (def) {
          await tx
            .update(funnelVersions)
            .set({ isActive: false })
            .where(eq(funnelVersions.definitionId, def.id));
        }

        await tx
          .update(funnelVersions)
          .set({ isActive: true, })
          .where(eq(funnelVersions.id, snapshot.priorFunnelVersionId));
      }

      for (const [name, enabled] of Object.entries(snapshot.priorValidatorToggles)) {
        await tx
          .update(validatorConfigs)
          .set({
            config: sql`jsonb_set(coalesce(${validatorConfigs.config}, '{}'::jsonb), '{enabled}', ${enabled ? 'true' : 'false'}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(validatorConfigs.personaId, draft.personaId),
            eq(validatorConfigs.validatorName, name),
          ));
      }

      await tx
        .update(tuningDrafts)
        .set({ status: 'rolled-back', updatedAt: new Date() })
        .where(eq(tuningDrafts.id, draftId));
    });
  }
}
