import type { FastifyPluginAsync } from 'fastify';
import { TuningDraftRepository } from '@undrecreaitwins/core/services/tuning/tuning-draft-repository.js';
import {
  GenerateRequest,
  ReviewRequest,
  InterviewAnswerRequest,
  SandboxPreviewRequest,
} from '../../schemas/tuning.js';
import { ValidationError, AppError, NotFoundError, ConflictError } from '@undrecreaitwins/shared';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';
import { DocExtractionPipeline } from '@undrecreaitwins/core/services/tuning/doc-extraction-pipeline.js';
import { ActivatePipeline } from '@undrecreaitwins/core/services/tuning/activate-pipeline.js';
import { ConversationAnalyzer } from '@undrecreaitwins/core/services/tuning/conversation-analyzer.js';
import { InterviewStateMachine } from '@undrecreaitwins/core/services/tuning/interview-state-machine.js';
import { ChatService } from '@undrecreaitwins/core/services/chat-service.js';
import type { DraftConfigOverlay, TuningDraftStatus } from '@undrecreaitwins/core/types/tuning.js';

const draftRepo = new TuningDraftRepository();
const conversationAnalyzer = new ConversationAnalyzer();
const interviewMachine = new InterviewStateMachine();

export const tuningRoutes: FastifyPluginAsync = async (fastify) => {
  // US1: Generate draft
  fastify.post('/v1/personas/:personaId/tuning/generate', async (request, reply) => {
    const { personaId } = request.params as { personaId: string };
    const parseResult = GenerateRequest.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    if (body.method === 'template-bootstrap') {
      reply.status(400);
      return { error: 'METHOD_NOT_IMPLEMENTED', message: 'Template-bootstrap method is not implemented' };
    }

    if (body.method !== 'doc-extraction') {
      reply.status(400);
      return { error: 'INVALID_METHOD', message: `Method '${body.method}' is not supported` };
    }

    // Validate persona exists and belongs to tenant
    const personaRepo = new PersonaRepository();
    try {
      await personaRepo.getById(request.tenantId, personaId);
    } catch {
      throw new NotFoundError('Persona', personaId);
    }

    // Sweep stale generating drafts first
    await draftRepo.sweepStaleGenerating(personaId, request.tenantId, 90_000);

    try {
      const draft = await draftRepo.create(request.tenantId, {
        personaId,
        method: body.method,
      });

      const pipeline = new DocExtractionPipeline();
      process.nextTick(() => {
        pipeline.run(draft.id, request.tenantId, personaId).catch(async (err: any) => {
          try {
            await draftRepo.update(request.tenantId, draft.id, {
              status: 'failed',
              error: (err?.message || 'CRASHED').slice(0, 500),
            });
          } catch {}
        });
      });

      reply.status(202);
      return { draftId: draft.id, status: 'generating' };
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictError('CONFLICT_DRAFT_ACTIVE');
      }
      throw err;
    }
  });

  // US1: Poll draft
  fastify.get('/v1/tuning/drafts/:draftId', async (request) => {
    const { draftId } = request.params as { draftId: string };
    const draft = await draftRepo.getById(request.tenantId, draftId);
    return draft;
  });

  // US1: List drafts
  fastify.get('/v1/personas/:personaId/tuning/drafts', async (request) => {
    const { personaId } = request.params as { personaId: string };
    const query = request.query as Record<string, string | undefined>;
    const drafts = await draftRepo.listByPersona(request.tenantId, personaId, query?.status as TuningDraftStatus | undefined);
    return { drafts };
  });

  // US2: Review draft
  fastify.post('/v1/tuning/drafts/:draftId/review', async (request) => {
    const { draftId } = request.params as { draftId: string };
    const parseResult = ReviewRequest.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    await draftRepo.update(request.tenantId, draftId, {
      reviewVerdict: body.verdict,
      reviewNotes: body.notes,
    });
    return { acknowledged: true };
  });

  const activatePipeline = new ActivatePipeline();

  // US2: Activate draft
  fastify.post('/v1/tuning/drafts/:draftId/activate', async (request) => {
    const { draftId } = request.params as { draftId: string };
    const result = await activatePipeline.activate(draftId, request.tenantId);
    return { status: 'activated', activatedAt: result.activatedAt };
  });

  // US2: Rollback draft
  fastify.post('/v1/tuning/drafts/:draftId/rollback', async (request) => {
    const { draftId } = request.params as { draftId: string };
    await activatePipeline.rollback(draftId, request.tenantId);
    return { status: 'rolled-back' };
  });

  // US5: Sandbox preview
  fastify.post('/v1/tuning/drafts/:draftId/sandbox-preview', async (request) => {
    const { draftId } = request.params as { draftId: string };
    const parseResult = SandboxPreviewRequest.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    const draft = await draftRepo.getById(request.tenantId, draftId);
    if (draft.status !== 'ready') {
      throw new AppError('Draft must be in ready status for preview', 400, 'DRAFT_NOT_READY');
    }

    const overlay: DraftConfigOverlay = {
      systemPrompt: draft.systemPrompt || undefined,
      funnelConfig: draft.funnelConfig as Record<string, unknown> | undefined,
      validatorToggles: draft.validatorToggles as Record<string, boolean> | undefined,
    };

    const overriddenParts: string[] = [];
    if (overlay.systemPrompt) overriddenParts.push('systemPrompt');
    if (overlay.funnelConfig) overriddenParts.push('funnelConfig');
    if (overlay.validatorToggles) overriddenParts.push('validatorToggles');

    const chatService = new ChatService();
    const result = await chatService.complete({
      tenantId: request.tenantId,
      personaId: draft.personaId,
      personaSlug: draft.personaId,
      messages: body.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      isTestThread: true,
      source: 'tuning-sandbox',
      draftOverride: overlay,
    });

    return {
      reply: result.choices[0]?.message?.content || '',
      metadata: {
        draftApplied: overriddenParts.length > 0,
        overriddenParts,
        ragEmpty: false,
      },
    };
  });

  // US3: Interview next
  fastify.post('/v1/personas/:personaId/tuning/interview/next', async (request) => {
    const { personaId } = request.params as { personaId: string };
    const userId = (request.headers['x-user-id'] as string) || 'default';
    return interviewMachine.getNextQuestion(request.tenantId, personaId, userId);
  });

  // US3: Interview answer
  fastify.post('/v1/personas/:personaId/tuning/interview/answer', async (request) => {
    const { personaId } = request.params as { personaId: string };
    const parseResult = InterviewAnswerRequest.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    const userId = (request.headers['x-user-id'] as string) || 'default';
    const acknowledged = await interviewMachine.submitAnswer(request.tenantId, personaId, userId, body.questionId, body.answer);
    if (!acknowledged) {
      throw new AppError('Interview session not found', 404, 'SESSION_NOT_FOUND');
    }
    return { acknowledged: true };
  });

  // US4: List proposals
  fastify.get('/v1/personas/:personaId/tuning/proposals', async (request) => {
    const { personaId } = request.params as { personaId: string };

    // Try cache first
    const cached = await conversationAnalyzer.getCachedProposals(request.tenantId, personaId);
    if (cached) {
      return { proposals: cached };
    }

    // Fresh analysis
    const result = await conversationAnalyzer.analyze(request.tenantId, personaId);
    return { proposals: result.proposals, warmup: result.warmup ? true : undefined };
  });

  // US4: Accept proposal
  fastify.post('/v1/tuning/proposals/:proposalId/accept', async (request) => {
    const { proposalId } = request.params as { proposalId: string };
    // We need personaId — try to find it from proposal cache
    // For v1, require personaId as query param
    const query = request.query as Record<string, string | undefined>;
    const personaId = query.personaId;
    if (!personaId) {
      throw new AppError('personaId query parameter is required', 400, 'MISSING_PERSONA_ID');
    }
    const result = await conversationAnalyzer.acceptProposal(request.tenantId, personaId, proposalId);
    if (!result) {
      throw new NotFoundError('Proposal', proposalId);
    }
    return { draftId: result.draftId };
  });

  // US4: Reject proposal
  fastify.post('/v1/tuning/proposals/:proposalId/reject', async (request) => {
    const { proposalId } = request.params as { proposalId: string };
    const query = request.query as Record<string, string | undefined>;
    const personaId = query.personaId;
    if (!personaId) {
      throw new AppError('personaId query parameter is required', 400, 'MISSING_PERSONA_ID');
    }
    await conversationAnalyzer.rejectProposal(request.tenantId, personaId, proposalId);
    return { dismissed: true };
  });

  // On startup: sweep stale generating drafts
  fastify.addHook('onReady', async () => {
    await draftRepo.sweepStaleGenerating(null, '*', 300_000);
  });
};
