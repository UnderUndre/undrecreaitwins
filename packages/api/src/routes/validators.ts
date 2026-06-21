import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { validatorConfigs, validatorRuns, personas } from '@undrecreaitwins/core/models/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { NotFoundError, AppError } from '@undrecreaitwins/shared';
import { BCP47_TO_SCRIPTS } from '@undrecreaitwins/core/services/validators/language-guard.js';

type ValidatorMode = 'active' | 'dry-run';

const languageGuardConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowedLanguages: z.array(z.string()).default([]),
  mode: z.enum(['active', 'dry-run']).default('dry-run'),
  stripThreshold: z.number().min(0).max(1).default(0.05),
  blockThreshold: z.number().min(0).max(1).default(0.30),
  fallbackMessage: z.string().optional(),
  regenerateOnViolation: z.boolean().default(false),
  targetPolicy: z.enum(['mirror', 'fixed']).default('mirror'),
  fixedLanguage: z.string().optional(),
  fallbackLanguage: z.string().optional(),
  remediation: z.enum(['translate', 'strip-block']).default('strip-block'),
  langidMinConfidence: z.number().min(0).max(1).default(0.7),
  allowPlatformModelRouting: z.boolean().default(false),
});

const putBodySchema = z.object({
  config: languageGuardConfigSchema,
  expectedVersion: z.number().int().min(0),
});

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}_${id}`).toString('base64');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const sep = decoded.indexOf('_');
    if (sep === -1) throw new Error();
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id) || isNaN(Date.parse(createdAt))) {
      throw new Error();
    }
    return { createdAt, id };
  } catch {
    throw new AppError('Invalid cursor', 400, 'invalid_cursor');
  }
}

type FieldError = { code: string; message: string };

function buildValidationErrors(issues: z.ZodIssue[]): Record<string, FieldError> {
  const fields: Record<string, FieldError> = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || 'body';
    fields[key] = { code: `ZOD_${issue.code.toUpperCase()}`, message: issue.message };
  }
  return fields;
}

async function verifyPersonaExists(tenantId: string, personaId: string): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: personas.id })
      .from(personas)
      .where(and(eq(personas.tenantId, tenantId), eq(personas.id, personaId)))
      .limit(1);
    if (!row) throw new NotFoundError('Persona', personaId);
  });
}

export const validatorRoutes: FastifyPluginAsync = async (fastify) => {
  // T005: GET /v1/personas/:personaId/validators/language-guard
  fastify.get('/v1/personas/:personaId/validators/language-guard', async (request) => {
    const { personaId } = request.params as { personaId: string };
    const tenantId = request.tenantId;

    await verifyPersonaExists(tenantId, personaId);

    const result = await withTenantContext(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(validatorConfigs)
        .where(
          and(
            eq(validatorConfigs.tenantId, tenantId),
            eq(validatorConfigs.personaId, personaId),
            eq(validatorConfigs.validatorName, 'language-guard')
          )
        );

      if (row) {
        const cfg = row.config as Record<string, unknown>;
        return {
          config: {
            enabled: cfg.enabled !== false,
            allowedLanguages: (cfg.allowedLanguages as string[]) ?? [],
            mode: row.mode as ValidatorMode,
            stripThreshold: (cfg.stripThreshold as number) ?? 0.05,
            blockThreshold: (cfg.blockThreshold as number) ?? 0.30,
            fallbackMessage: cfg.fallbackMessage as string | undefined,
            regenerateOnViolation: (cfg.regenerateOnViolation as boolean) ?? false,
            targetPolicy: (cfg.targetPolicy as 'mirror' | 'fixed') ?? 'mirror',
            fixedLanguage: cfg.fixedLanguage as string | undefined,
            fallbackLanguage: cfg.fallbackLanguage as string | undefined,
            remediation: (cfg.remediation as 'translate' | 'strip-block') ?? 'strip-block',
            langidMinConfidence: (cfg.langidMinConfidence as number) ?? 0.7,
            allowPlatformModelRouting: (cfg.allowPlatformModelRouting as boolean) ?? false,
          },
          configVersion: row.version,
        };
      }

      // Defaults when never configured
      return {
        config: {
          enabled: true,
          allowedLanguages: [],
          mode: 'dry-run' as ValidatorMode,
          stripThreshold: 0.05,
          blockThreshold: 0.30,
          regenerateOnViolation: false,
          targetPolicy: 'mirror' as const,
          remediation: 'strip-block' as const,
          langidMinConfidence: 0.7,
          allowPlatformModelRouting: false,
        },
        configVersion: 0,
      };
    });

    return result;
  });

  // T006+T008+T009: PUT /v1/personas/:personaId/validators/language-guard
  fastify.put('/v1/personas/:personaId/validators/language-guard', async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenantId = request.tenantId;

    await verifyPersonaExists(tenantId, personaId);

    // D-4: Pre-Zod check for MISSING_EXPECTED_VERSION (distinct error code per contract)
    if (request.body === undefined || request.body === null || typeof request.body !== 'object' || !('expectedVersion' in request.body)) {
      return reply.status(400).send({
        error: 'MISSING_EXPECTED_VERSION',
        message: 'expectedVersion is required',
      });
    }

    // Validate body
    const parseResult = putBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        fields: buildValidationErrors(parseResult.error.issues),
      });
    }

    const { config, expectedVersion } = parseResult.data;

    // T006: Server-side validation
    const validationErrors: Record<string, FieldError> = {};

    if (config.stripThreshold > config.blockThreshold) {
      validationErrors.stripThreshold = { code: 'THRESHOLD_ORDER', message: 'stripThreshold must be <= blockThreshold' };
    }

    if (config.mode === 'active' && config.allowedLanguages.length === 0) {
      validationErrors.allowedLanguages = { code: 'EMPTY_ACTIVE_LANGUAGES', message: 'allowedLanguages must not be empty when mode is active' };
    }

    // Default fallbackLanguage = allowedLanguages[0] if not specified
    if (!config.fallbackLanguage && config.allowedLanguages.length > 0) {
      config.fallbackLanguage = config.allowedLanguages[0];
    }

    if (config.fallbackLanguage && !config.allowedLanguages.includes(config.fallbackLanguage)) {
      validationErrors.fallbackLanguage = { code: 'INVALID_FALLBACK_LANGUAGE', message: 'fallbackLanguage must be one of the allowedLanguages' };
    }

    if (config.targetPolicy === 'fixed' && !config.fixedLanguage) {
      validationErrors.fixedLanguage = { code: 'MISSING_FIXED_LANGUAGE', message: 'fixedLanguage is required when targetPolicy is fixed' };
    }

    for (const lang of config.allowedLanguages) {
      if (!(lang in BCP47_TO_SCRIPTS)) {
        validationErrors.allowedLanguages = { code: 'INVALID_BCP47', message: `Invalid BCP-47 language code: ${lang}` };
        break;
      }
    }

    if (config.fixedLanguage && !(config.fixedLanguage in BCP47_TO_SCRIPTS)) {
      validationErrors.fixedLanguage = { code: 'INVALID_BCP47', message: `Invalid BCP-47 language code: ${config.fixedLanguage}` };
    }

    if (config.fallbackLanguage && !(config.fallbackLanguage in BCP47_TO_SCRIPTS)) {
      validationErrors.fallbackLanguage = { code: 'INVALID_BCP47', message: `Invalid BCP-47 language code: ${config.fallbackLanguage}` };
    }

    if (Object.keys(validationErrors).length > 0) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        fields: validationErrors,
      });
    }

    // Dedupe allowedLanguages
    const dedupedLanguages = [...new Set(config.allowedLanguages)];

    type PutResult =
      | { conflict: true; currentConfig: Record<string, unknown> | null; currentVersion: number; error?: { code: string; message: string } }
      | { conflict: false; config: typeof config; configVersion: number };

    // D-1: Use SELECT FOR UPDATE + conditional INSERT/UPDATE (not UPSERT) for correct version checking
    const result = (await withTenantContext(tenantId, async (tx) => {
      // Lock the row (or detect absence)
      const [existing] = await tx
        .select()
        .from(validatorConfigs)
        .where(
          and(
            eq(validatorConfigs.tenantId, tenantId),
            eq(validatorConfigs.personaId, personaId),
            eq(validatorConfigs.validatorName, 'language-guard')
          )
        )
        .for('update');

      const configPayload = {
        enabled: config.enabled,
        allowedLanguages: dedupedLanguages,
        stripThreshold: config.stripThreshold,
        blockThreshold: config.blockThreshold,
        fallbackMessage: config.fallbackMessage,
        regenerateOnViolation: config.regenerateOnViolation,
        targetPolicy: config.targetPolicy,
        fixedLanguage: config.fixedLanguage,
        fallbackLanguage: config.fallbackLanguage,
        remediation: config.remediation,
        langidMinConfidence: config.langidMinConfidence,
        allowPlatformModelRouting: config.allowPlatformModelRouting,
      };

      if (!existing) {
        // First write — expectedVersion must be 0
        if (expectedVersion !== 0) {
          return {
            conflict: true,
            currentConfig: null,
            currentVersion: 0,
          };
        }

        const [row] = await tx
          .insert(validatorConfigs)
          .values({
            tenantId,
            personaId,
            validatorName: 'language-guard',
            mode: config.mode,
            config: configPayload,
            version: 1,
          })
          .returning();

        return {
          conflict: false,
          config: { ...config, allowedLanguages: dedupedLanguages },
          configVersion: row!.version,
        };
      }

      // Version matches — apply update
      if (existing.version !== expectedVersion) {
        const cfg = existing.config as Record<string, unknown>;
        return {
          conflict: true,
          currentConfig: {
            enabled: cfg.enabled !== false,
            allowedLanguages: (cfg.allowedLanguages as string[]) ?? [],
            mode: existing.mode as ValidatorMode,
            stripThreshold: (cfg.stripThreshold as number) ?? 0.05,
            blockThreshold: (cfg.blockThreshold as number) ?? 0.30,
            fallbackMessage: cfg.fallbackMessage as string | undefined,
            regenerateOnViolation: (cfg.regenerateOnViolation as boolean) ?? false,
            targetPolicy: (cfg.targetPolicy as 'mirror' | 'fixed') ?? 'mirror',
            fixedLanguage: cfg.fixedLanguage as string | undefined,
            fallbackLanguage: cfg.fallbackLanguage as string | undefined,
            remediation: (cfg.remediation as 'translate' | 'strip-block') ?? 'strip-block',
            langidMinConfidence: (cfg.langidMinConfidence as number) ?? 0.7,
            allowPlatformModelRouting: (cfg.allowPlatformModelRouting as boolean) ?? false,
          },
          currentVersion: existing.version,
        };
      }

      // Overflow protection
      if (existing.version >= 2147483647) {
        const cfg = existing.config as Record<string, unknown>;
        return {
          conflict: true,
          currentConfig: {
            enabled: cfg.enabled !== false,
            allowedLanguages: (cfg.allowedLanguages as string[]) ?? [],
            mode: existing.mode as ValidatorMode,
            stripThreshold: (cfg.stripThreshold as number) ?? 0.05,
            blockThreshold: (cfg.blockThreshold as number) ?? 0.30,
            fallbackMessage: cfg.fallbackMessage as string | undefined,
            regenerateOnViolation: (cfg.regenerateOnViolation as boolean) ?? false,
            targetPolicy: (cfg.targetPolicy as 'mirror' | 'fixed') ?? 'mirror',
            fixedLanguage: cfg.fixedLanguage as string | undefined,
            fallbackLanguage: cfg.fallbackLanguage as string | undefined,
            remediation: (cfg.remediation as 'translate' | 'strip-block') ?? 'strip-block',
            langidMinConfidence: (cfg.langidMinConfidence as number) ?? 0.7,
            allowPlatformModelRouting: (cfg.allowPlatformModelRouting as boolean) ?? false,
          },
          currentVersion: existing.version,
          error: {
            code: 'VERSION_OVERFLOW',
            message: 'configVersion has reached maximum. Contact administrator to reset.',
          },
        };
      }

      // Version matches — apply update
      const [row] = await tx
        .update(validatorConfigs)
        .set({
          mode: config.mode,
          config: configPayload,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(validatorConfigs.tenantId, tenantId),
            eq(validatorConfigs.personaId, personaId),
            eq(validatorConfigs.validatorName, 'language-guard'),
            eq(validatorConfigs.version, expectedVersion)
          )
        )
        .returning();

      if (!row) {
        // Lost race between SELECT FOR UPDATE and UPDATE (shouldn't happen within same tx)
        return { conflict: true, currentConfig: null, currentVersion: expectedVersion };
      }

      return {
        conflict: false,
        config: { ...config, allowedLanguages: dedupedLanguages },
        configVersion: row.version,
      };
    }).catch((err: any) => {
      if (err.code === '23505') {
        return { conflict: true, currentConfig: null, currentVersion: 0 };
      }
      throw err;
    })) as PutResult;

    if (result.conflict) {
      if (result.error) {
        return reply.status(409).send({
          error: 'CONFLICT',
          errorDetails: result.error,
          currentConfig: result.currentConfig,
          currentVersion: result.currentVersion,
        });
      }
      return reply.status(409).send({
        error: 'CONFLICT',
        currentConfig: result.currentConfig,
        currentVersion: result.currentVersion,
      });
    }

    return {
      config: result.config,
      configVersion: result.configVersion,
    };
  });

  // T010: GET /v1/personas/:personaId/validators/language-guard/logs
  fastify.get('/v1/personas/:personaId/validators/language-guard/logs', async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const tenantId = request.tenantId;
    const query = request.query as { limit?: string; cursor?: string };

    await verifyPersonaExists(tenantId, personaId);

    // D-3: limit < 1 → 400 (per FR-006), not silent clamp
    const parsedLimit = query.limit !== undefined ? parseInt(query.limit, 10) : 20;
    if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        fields: { limit: 'limit must be >= 1' },
      });
    }
    const limit = Math.min(parsedLimit, 100);

    let cursorFilter = sql`true`;
    if (query.cursor) {
      try {
        const { createdAt, id } = decodeCursor(query.cursor);
        cursorFilter = sql`(${validatorRuns.createdAt} < ${createdAt}::timestamptz OR (${validatorRuns.createdAt} = ${createdAt}::timestamptz AND ${validatorRuns.id} < ${id}::uuid))`;
      } catch {
        return reply.status(400).send({ error: 'INVALID_CURSOR', message: 'Malformed cursor' });
      }
    }

    const result = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: validatorRuns.id,
          verdict: validatorRuns.verdict,
          confidence: validatorRuns.confidence,
          matchedPatterns: validatorRuns.matchedPatterns,
          createdAt: validatorRuns.createdAt,
        })
        .from(validatorRuns)
        .where(
          and(
            eq(validatorRuns.tenantId, tenantId),
            eq(validatorRuns.personaId, personaId),
            eq(validatorRuns.validatorName, 'language-guard'),
            cursorFilter
          )
        )
        .orderBy(sql`${validatorRuns.createdAt} DESC, ${validatorRuns.id} DESC`)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items[items.length - 1];

      return {
        items: items.map((r) => {
          const matched = (r.matchedPatterns as string[]) ?? [];
          const detectedScripts = matched.filter(s => !s.includes(':'));
          
          let remediation = 'pass';
          let sourceLang: string | undefined;
          let targetLang: string | undefined;
          let fidelityOk: boolean | undefined;
          let reason: string | undefined;

          for (const s of matched) {
            if (s.startsWith('remediation:')) {
              remediation = s.slice('remediation:'.length);
            } else if (s.startsWith('sourceLang:')) {
              sourceLang = s.slice('sourceLang:'.length) || undefined;
            } else if (s.startsWith('targetLang:')) {
              targetLang = s.slice('targetLang:'.length) || undefined;
            } else if (s.startsWith('fidelityOk:')) {
              fidelityOk = s.slice('fidelityOk:'.length) === 'true';
            } else if (s.startsWith('reason:')) {
              reason = s.slice('reason:'.length) || undefined;
            }
          }

          return {
            id: r.id,
            verdict: r.verdict,
            metadata: {
              nonCompliantFraction: r.confidence ?? 0,
              detectedScripts,
              remediation,
              sourceLang,
              targetLang,
              fidelityOk,
              reason,
            },
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          };
        }),
        nextCursor: hasMore && lastItem
          ? encodeCursor(
              lastItem.createdAt instanceof Date ? lastItem.createdAt.toISOString() : String(lastItem.createdAt),
              lastItem.id
            )
          : null,
      };
    });

    return result;
  });
};
