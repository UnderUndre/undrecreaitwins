import { db } from '../../db.js';
import { 
  funnelDefinitions, 
  funnelVersions, 
  funnelStages, 
  funnelFragments,
  funnelSlots,
  conversationFunnelStates 
} from '../../models/index.js';
import { eq, and, isNull, sql, desc } from 'drizzle-orm';
import type { 
  ConversationFunnelState,
  FullFunnel,
  FunnelDefinition,
  FunnelVersion,
  FunnelConfig,
  FunnelStage,
  FunnelFragment,
  FunnelSlot
} from '@undrecreaitwins/shared';

export class FunnelRepository {
  public async getFullVersion(versionId: string): Promise<FullFunnel | null> {
    const version = await db.query.funnelVersions.findFirst({
      where: eq(funnelVersions.id, versionId),
      with: {
        definition: true,
        stages: {
          with: {
            fragments: true,
          },
          orderBy: [sql`${funnelStages.order} ASC`],
        },
        slots: true,
      },
    });

    if (!version) return null;
    return version as any;
  }

  public async getActiveVersion(tenantId: string, personaId: string): Promise<FullFunnel | null> {
    const def = await db.query.funnelDefinitions.findFirst({
      where: and(
        eq(funnelDefinitions.tenantId, tenantId),
        eq(funnelDefinitions.personaId, personaId),
        isNull(funnelDefinitions.deletedAt)
      ),
    });

    if (!def) return null;

    const version = await db.query.funnelVersions.findFirst({
      where: and(
        eq(funnelVersions.definitionId, def.id),
        eq(funnelVersions.isActive, true)
      ),
      with: {
        stages: {
          with: {
            fragments: true,
          },
          orderBy: [sql`${funnelStages.order} ASC`],
        },
        slots: true,
      },
    });

    if (!version) return null;

    return {
      ...version,
      definition: def,
    } as any;
  }

  public async getConversationState(conversationId: string): Promise<ConversationFunnelState | null> {
    const state = await db.query.conversationFunnelStates.findFirst({
      where: eq(conversationFunnelStates.conversationId, conversationId),
    });
    return state as any;
  }

  public async updateConversationState(
    conversationId: string, 
    update: Partial<ConversationFunnelState>, 
    expectedVersion: number
  ): Promise<boolean> {
    const result = await db.update(conversationFunnelStates)
      .set({
        ...update,
        version: sql`${conversationFunnelStates.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversationFunnelStates.conversationId, conversationId),
        eq(conversationFunnelStates.version, expectedVersion)
      ));
    
    return (result as any).rowCount > 0;
  }

  public async createConversationState(state: Omit<ConversationFunnelState, 'updatedAt'>): Promise<void> {
    await db.insert(conversationFunnelStates).values({
      ...state,
      version: 0,
    });
  }

  public async resetConversationState(conversationId: string): Promise<void> {
    await db.delete(conversationFunnelStates).where(eq(conversationFunnelStates.conversationId, conversationId));
  }

  public async createFunnel(tenantId: string, personaId: string, name: string): Promise<FunnelDefinition> {
    const [def] = await db.insert(funnelDefinitions).values({
      tenantId,
      personaId,
      name,
    }).returning();
    return def as any;
  }

  public async createVersion(
    definitionId: string, 
    config: FunnelConfig, 
    stages: (Omit<FunnelStage, 'id' | 'funnelVersionId'> & { fragments: Omit<FunnelFragment, 'id' | 'funnelVersionId' | 'stageId'>[] })[],
    slots: Omit<FunnelSlot, 'id' | 'funnelVersionId'>[]
  ): Promise<FunnelVersion> {
    return await db.transaction(async (tx) => {
      // 1. Get next version number
      const lastVersion = await tx.query.funnelVersions.findFirst({
        where: eq(funnelVersions.definitionId, definitionId),
        orderBy: [desc(funnelVersions.versionNumber)],
      });
      const nextNumber = (lastVersion?.versionNumber ?? 0) + 1;

      // 2. Deactivate previous versions
      await tx.update(funnelVersions)
        .set({ isActive: false })
        .where(eq(funnelVersions.definitionId, definitionId));

      // 3. Create new version
      const [version] = await tx.insert(funnelVersions).values({
        definitionId,
        versionNumber: nextNumber,
        config,
        isActive: true,
      }).returning();

      // 4. Create stages and fragments
      for (const stageData of stages) {
        const { fragments, ...sData } = stageData;
        const [stage] = await tx.insert(funnelStages).values({
          ...sData,
          funnelVersionId: version.id,
        }).returning();

        if (fragments.length > 0) {
          await tx.insert(funnelFragments).values(
            fragments.map(f => ({
              ...f,
              funnelVersionId: version.id,
              stageId: stage.id,
            }))
          );
        }
      }

      // 5. Create slots
      if (slots.length > 0) {
        await tx.insert(funnelSlots).values(
          slots.map(s => ({
            ...s,
            funnelVersionId: version.id,
          }))
        );
      }

      return version as any;
    });
  }

  public async deleteFunnel(tenantId: string, id: string): Promise<void> {
    await db.update(funnelDefinitions)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(funnelDefinitions.id, id),
        eq(funnelDefinitions.tenantId, tenantId)
      ));
  }
}
