import { eq, and, sql, count } from 'drizzle-orm';
import { annotations, personas } from '../models/index.js';
import { withTenantContext } from '../db.js';
import { NotFoundError } from '@undrecreaitwins/shared';
import type { EmbeddingService } from './embedding-service.js';

export class AnnotationService {
  constructor(private readonly embeddingService: EmbeddingService) {}

  async upsert(tenantId: string, data: {
    personaId: string;
    originalQuery: string;
    badResponse: string;
    correctedResponse: string;
  }): Promise<string> {
    const normalizedQuery = data.originalQuery.trim().toLowerCase().replace(/\s+/g, ' ');
    const embedding = await this.embeddingService.embed(normalizedQuery);

    return withTenantContext(tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(annotations)
        .where(
          and(
            eq(annotations.personaId, data.personaId),
            eq(annotations.normalizedQuery, normalizedQuery)
          )
        );

      let annotationId: string;

      if (existing) {
        await tx
          .update(annotations)
          .set({
            badResponse: data.badResponse,
            correctedResponse: data.correctedResponse,
            embedding,
            updatedAt: new Date(),
          })
          .where(eq(annotations.id, existing.id));
        annotationId = existing.id;
      } else {
        const [inserted] = await tx
          .insert(annotations)
          .values({
            tenantId,
            personaId: data.personaId,
            originalQuery: data.originalQuery,
            normalizedQuery,
            badResponse: data.badResponse,
            correctedResponse: data.correctedResponse,
            embedding,
          })
          .returning({ id: annotations.id });
        
        if (!inserted) throw new Error('Failed to insert annotation');
        annotationId = inserted.id;

        // Toggle hasAnnotations to true (gemini F2)
        await tx
          .update(personas)
          .set({ hasAnnotations: true })
          .where(eq(personas.id, data.personaId));
      }

      return annotationId;
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await withTenantContext(tenantId, async (tx) => {
      const [deleted] = await tx
        .delete(annotations)
        .where(eq(annotations.id, id))
        .returning({ personaId: annotations.personaId });

      if (!deleted) throw new NotFoundError('Annotation', id);

      // Recalculate hasAnnotations (gemini F2)
      const [result] = await tx
        .select({ value: count() })
        .from(annotations)
        .where(eq(annotations.personaId, deleted.personaId));
      
      if (result && result.value === 0) {
        await tx
          .update(personas)
          .set({ hasAnnotations: false })
          .where(eq(personas.id, deleted.personaId));
      }
    });
  }

  async retrieve(tenantId: string, personaId: string, queryEmbedding: number[], threshold: number, limit = 3): Promise<any[]> {
    return withTenantContext(tenantId, async (tx) => {
      // Cosine similarity = 1 - cosine distance
      // pgvector cosine distance operator is <=> 
      return tx
        .select()
        .from(annotations)
        .where(
          and(
            eq(annotations.personaId, personaId),
            sql`1 - (${annotations.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector) >= ${threshold}`
          )
        )
        .orderBy(sql`${annotations.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`)
        .limit(limit);
    });
  }
}
