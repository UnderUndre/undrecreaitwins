import { eq, and, sql } from 'drizzle-orm';
import { personas } from '../models/index.js';
import { withTenantContext } from '../db.js';
import { NotFoundError, ConflictError } from '@undrecreaitwins/shared';
import type { PersonaTraits, ModelPreferences } from '@undrecreaitwins/shared';

type NewPersona = {
  name: string;
  slug: string;
  systemPrompt: string;
  traits?: PersonaTraits;
  modelPreferences?: ModelPreferences;
  annotationSimilarityThreshold?: number;
};

type UpdatePersona = {
  name?: string;
  slug?: string;
  systemPrompt?: string;
  traits?: PersonaTraits;
  modelPreferences?: ModelPreferences;
  annotationSimilarityThreshold?: number;
  expectedVersion?: number;
};

type PersonaRow = typeof personas.$inferSelect;

export class PersonaRepository {
  async create(tenantId: string, data: NewPersona): Promise<PersonaRow> {
    return withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .insert(personas)
        .values({
          tenantId,
          name: data.name,
          slug: data.slug,
          systemPrompt: data.systemPrompt,
          traits: data.traits || {},
          modelPreferences: data.modelPreferences || {},
          annotationSimilarityThreshold: data.annotationSimilarityThreshold,
        })
        .returning();
      const persona = rows[0];
      if (!persona) {
        throw new Error('Insert returned no rows');
      }
      return persona;
    });
  }

  async getById(tenantId: string, id: string): Promise<PersonaRow> {
    return withTenantContext(tenantId, async (tx) => {
      const [persona] = await tx
        .select()
        .from(personas)
        .where(eq(personas.id, id))
        .limit(1);
      if (!persona) {
        throw new NotFoundError('Persona', id);
      }
      return persona;
    });
  }

  async getBySlug(tenantId: string, slug: string): Promise<PersonaRow> {
    return withTenantContext(tenantId, async (tx) => {
      const [persona] = await tx
        .select()
        .from(personas)
        .where(and(eq(personas.tenantId, tenantId), eq(personas.slug, slug)))
        .limit(1);
      if (!persona) {
        throw new NotFoundError('Persona', slug);
      }
      return persona;
    });
  }

  async list(
    tenantId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ data: PersonaRow[]; total: number }> {
    return withTenantContext(tenantId, async (tx) => {
      const data = await tx
        .select()
        .from(personas)
        .limit(limit)
        .offset(offset);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(personas);
      return { data, total: countRow?.count ?? 0 };
    });
  }

  async update(tenantId: string, id: string, data: UpdatePersona): Promise<PersonaRow> {
    return withTenantContext(tenantId, async (tx) => {
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) updateData.name = data.name;
      if (data.slug !== undefined) updateData.slug = data.slug;
      if (data.systemPrompt !== undefined) updateData.systemPrompt = data.systemPrompt;
      if (data.traits !== undefined) updateData.traits = data.traits;
      if (data.modelPreferences !== undefined) updateData.modelPreferences = data.modelPreferences;
      if (data.annotationSimilarityThreshold !== undefined) {
        updateData.annotationSimilarityThreshold = data.annotationSimilarityThreshold;
      }

      const conditions = [eq(personas.id, id)];
      if (data.expectedVersion !== undefined) {
        conditions.push(eq(personas.version, data.expectedVersion));
      }

      const [updated] = await tx
        .update(personas)
        .set({ ...updateData, version: sql`${personas.version} + 1` })
        .where(and(...conditions))
        .returning();

      if (!updated) {
        if (data.expectedVersion !== undefined) {
          throw new ConflictError('Version conflict — persona was modified by another operation');
        }
        throw new NotFoundError('Persona', id);
      }
      return updated;
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    return withTenantContext(tenantId, async (tx) => {
      const [deleted] = await tx
        .delete(personas)
        .where(eq(personas.id, id))
        .returning({ id: personas.id });
      if (!deleted) {
        throw new NotFoundError('Persona', id);
      }
    });
  }
}
