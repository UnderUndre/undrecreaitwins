import { readdir, readFile } from 'fs/promises';
import { resolve, extname, join } from 'path';
import { z } from 'zod';
import { ValidationError } from '@undrecreaitwins/shared';
import type { EvalCase } from './eval-types.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const assertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('contains'),
    value: z.string().min(1),
    case_sensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('not_contains'),
    value: z.string().min(1),
    case_sensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('regex'),
    pattern: z.string().min(1),
    flags: z.string().regex(/^[dgimsuvy]*$/).optional(),
  }),
  z.object({
    type: z.literal('min_length'),
    value: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('max_length'),
    value: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('similarity'),
    expected: z.string().min(1),
    threshold: z.number().min(0).max(1),
  }),
]);

const caseSchema = z.object({
  name: z.string().min(1),
  personaSlug: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  assertions: z.array(assertionSchema).min(1),
});

const caseFileSchema = z.union([caseSchema, z.array(caseSchema)]);

export class EvalCaseLoader {
  constructor(private readonly casesDir = process.env.EVAL_CASES_PATH ?? resolve(process.cwd(), 'eval-cases')) {}

  async loadCases(caseNames?: string[]): Promise<EvalCase[]> {
    let entries: string[];
    try {
      entries = await readdir(this.casesDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read eval case directory';
      throw new ValidationError([{ field: 'cases_dir', message }]);
    }
    const jsonFiles = entries
      .filter((entry) => extname(entry) === '.json')
      .sort();

    const cases: EvalCase[] = [];
    for (const file of jsonFiles) {
      const raw = await readFile(join(this.casesDir, file), 'utf8');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON';
        throw new ValidationError([{ field: file, message }]);
      }
      const parsed = caseFileSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((issue) => ({
          field: `${file}.${issue.path.join('.')}`,
          message: issue.message,
        })));
      }
      cases.push(...(Array.isArray(parsed.data) ? parsed.data : [parsed.data]));
    }

    if (!caseNames || caseNames.length === 0) {
      return cases;
    }

    const requested = new Set(caseNames);
    const selected = cases.filter((evalCase) => requested.has(evalCase.name));
    const found = new Set(selected.map((evalCase) => evalCase.name));
    const missing = caseNames.filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new ValidationError(missing.map((name) => ({
        field: 'case_names',
        message: `Eval case not found: ${name}`,
      })));
    }

    return selected;
  }
}
