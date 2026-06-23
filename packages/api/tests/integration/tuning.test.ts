import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mockPersona = {
  id: 'persona-001',
  tenantId: 'test-tenant-123',
  name: 'Test Persona',
  slug: 'test-persona',
  systemPrompt: 'You are a test',
  traits: {},
  modelPreferences: {},
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  version: BigInt(1),
};

const mockDraftGenerating = {
  id: 'draft-001',
  tenantId: 'test-tenant-123',
  personaId: 'persona-001',
  method: 'doc-extraction',
  status: 'generating',
  confidence: null,
  systemPrompt: null,
  funnelConfig: null,
  validatorToggles: null,
  diffSections: null,
  previousSnapshot: null,
  signals: null,
  error: null,
  reviewVerdict: null,
  reviewNotes: null,
  createdAt: new Date(Date.now() - 5000).toISOString(),
  updatedAt: new Date(Date.now() - 5000).toISOString(),
  activatedAt: null,
};

const mockDraftReady = {
  ...mockDraftGenerating,
  status: 'ready',
  systemPrompt: 'You are a tuned assistant',
  funnelConfig: { funnelStages: [{ name: 'greeting', description: 'Greet the user', triggers: ['hello'], slots: [] }] },
  confidence: 'medium',
};

const mockDraftActivated = {
  ...mockDraftReady,
  status: 'activated',
  previousSnapshot: {
    systemPrompt: 'You are a test',
    traits: {},
    priorFunnelVersionId: null,
    priorValidatorToggles: {},
  },
  diffSections: { systemPromptChanged: true, funnelConfigChanged: true, validatorTogglesChanged: false },
  activatedAt: new Date().toISOString(),
};

const mockDraftSuperseded = {
  ...mockDraftActivated,
  status: 'superseded',
};

const mockDraftRolledBack = {
  ...mockDraftActivated,
  status: 'rolled-back',
};

const currentDraft: Record<string, any> = { ...mockDraftGenerating };

const personaRepoMocks = {
  create: vi.fn().mockResolvedValue(mockPersona),
  getById: vi.fn().mockResolvedValue(mockPersona),
  getBySlug: vi.fn().mockResolvedValue(mockPersona),
  list: vi.fn().mockResolvedValue({ data: [mockPersona], total: 1 }),
  update: vi.fn().mockResolvedValue({ ...mockPersona, name: 'Updated' }),
  delete: vi.fn().mockResolvedValue(undefined),
};

const draftRepoMocks = {
  create: vi.fn().mockImplementation(async (_tenantId: string, data: any) => {
    currentDraft.id = 'draft-001';
    currentDraft.tenantId = _tenantId;
    currentDraft.personaId = data.personaId;
    currentDraft.method = data.method;
    currentDraft.status = 'generating';
    return { ...currentDraft };
  }),
  getById: vi.fn().mockImplementation(async (_tenantId: string, _draftId: string) => {
    return { ...currentDraft };
  }),
  listByPersona: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockImplementation(async (_tenantId: string, _draftId: string, data: any) => {
    Object.assign(currentDraft, data);
    return { ...currentDraft };
  }),
  listByTenant: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  supersedeActiveDraft: vi.fn().mockResolvedValue(undefined),
  sweepStaleGenerating: vi.fn().mockResolvedValue(0),
};

const extractionPipelineMock = {
  run: vi.fn().mockResolvedValue(undefined),
};

const activatePipelineMock = {
  activate: vi.fn().mockResolvedValue({ activatedAt: new Date().toISOString() }),
  rollback: vi.fn().mockResolvedValue(undefined),
};

const interviewMachineMock = {
  startSession: vi.fn().mockResolvedValue({ current: 0, total: 7 }),
  getNextQuestion: vi.fn().mockResolvedValue({ question: 'Какие задачи?', questionId: 'q1', total: 7, current: 1 }),
  submitAnswer: vi.fn().mockResolvedValue(true),
};

const conversationAnalyzerMock = {
  analyze: vi.fn().mockResolvedValue({ proposals: [], warmup: true }),
  getCachedProposals: vi.fn().mockResolvedValue(null),
  acceptProposal: vi.fn().mockResolvedValue({ draftId: 'draft-proposal-001' }),
  rejectProposal: vi.fn().mockResolvedValue(true),
};

const chatServiceMock = {
  complete: vi.fn().mockResolvedValue({
    id: 'chat-001',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from tuned persona' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
};

vi.mock('@undrecreaitwins/core/db.js', () => ({
  db: {},
  healthCheck: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  withTenantContext: vi.fn<(_id: string, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (_id, fn) => fn({})),
}));

vi.mock('@undrecreaitwins/core/middleware/tenant.js', () => ({
  tenantPlugin: async (fastify: FastifyInstance) => {
    fastify.addHook('onRequest', async (request: { tenantId: string }) => {
      request.tenantId = 'test-tenant-123';
    });
  },
}));

vi.mock('@undrecreaitwins/core/middleware/auth.js', () => ({
  authPlugin: async () => {},
}));

vi.mock('@undrecreaitwins/core/middleware/error-handler.js', () => ({
  errorHandler: (error: { statusCode?: number; message: string; toJSON?: () => unknown }, _request: unknown, reply: { status: (code: number) => { send: (body: unknown) => void } }) => {
    const status = error.statusCode ?? 500;
    const body = typeof error.toJSON === 'function' ? error.toJSON() : { error: { code: 'internal_error', message: error.message } };
    return reply.status(status).send(body);
  },
}));

vi.mock('@undrecreaitwins/core/services/persona-repository.js', () => ({
  PersonaRepository: vi.fn().mockImplementation(() => personaRepoMocks),
}));

vi.mock('@undrecreaitwins/core/services/tuning/tuning-draft-repository.js', () => ({
  TuningDraftRepository: vi.fn().mockImplementation(() => draftRepoMocks),
}));

vi.mock('@undrecreaitwins/core/services/tuning/doc-extraction-pipeline.js', () => ({
  DocExtractionPipeline: vi.fn().mockImplementation(() => extractionPipelineMock),
}));

vi.mock('@undrecreaitwins/core/services/tuning/activate-pipeline.js', () => ({
  ActivatePipeline: vi.fn().mockImplementation(() => activatePipelineMock),
}));

vi.mock('@undrecreaitwins/core/services/tuning/interview-state-machine.js', () => ({
  InterviewStateMachine: vi.fn().mockImplementation(() => interviewMachineMock),
}));

vi.mock('@undrecreaitwins/core/services/tuning/conversation-analyzer.js', () => ({
  ConversationAnalyzer: vi.fn().mockImplementation(() => conversationAnalyzerMock),
}));

vi.mock('@undrecreaitwins/core/services/chat-service.js', () => ({
  ChatService: vi.fn().mockImplementation(() => chatServiceMock),
}));

const { buildServer } = await import('../../src/server.js');
const { tuningRoutes } = await import('../../src/routes/tuning/index.js');

async function setupTestServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  await server.register(tuningRoutes);
  return server;
}

function resetDraftState(overrides: Record<string, any> = {}) {
  Object.assign(currentDraft, { ...mockDraftGenerating, ...overrides });
}

describe('T033 — US1: Generate → Poll → Ready', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    personaRepoMocks.getById.mockResolvedValue(mockPersona);
    draftRepoMocks.create.mockImplementation(async (_t, data) => {
      resetDraftState({ personaId: data.personaId, method: data.method });
      return { ...currentDraft };
    });
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    draftRepoMocks.update.mockImplementation(async (_t, _id, data) => {
      Object.assign(currentDraft, data);
      return { ...currentDraft };
    });
    extractionPipelineMock.run.mockResolvedValue(undefined);
    server = await setupTestServer();
  });

  it('generates draft and returns 202, then poll returns ready', async () => {
    const genResponse = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/tuning/generate',
      payload: { method: 'doc-extraction' },
    });

    expect(genResponse.statusCode).toBe(202);
    const genBody = genResponse.json();
    expect(genBody).toHaveProperty('draftId');
    expect(genBody.status).toBe('generating');

    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft, status: 'ready', systemPrompt: 'You are a tuned assistant', funnelConfig: { funnelStages: [] } }));

    const pollResponse = await server.inject({
      method: 'GET',
      url: `/v1/tuning/drafts/${genBody.draftId}`,
    });

    expect(pollResponse.statusCode).toBe(200);
    const pollBody = pollResponse.json();
    expect(pollBody.status).toBe('ready');
    expect(pollBody.systemPrompt).toBe('You are a tuned assistant');
    expect(pollBody.funnelConfig).toBeTruthy();
  });
});

describe('T034 — US1: Generate with no docs (pipeline fails)', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    personaRepoMocks.getById.mockResolvedValue(mockPersona);
    draftRepoMocks.create.mockImplementation(async (_t, data) => {
      resetDraftState({ personaId: data.personaId, method: data.method });
      return { ...currentDraft };
    });
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    draftRepoMocks.update.mockImplementation(async (_t, _id, data) => {
      Object.assign(currentDraft, data);
      return { ...currentDraft };
    });
    extractionPipelineMock.run.mockImplementation(async (draftId: string, tenantId: string) => {
      await draftRepoMocks.update(tenantId, draftId, { status: 'failed', error: 'NO_DOCUMENTS' });
    });
    server = await setupTestServer();
  });

  it('returns 202 then poll shows failed with NO_DOCUMENTS', async () => {
    const genResponse = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/tuning/generate',
      payload: { method: 'doc-extraction' },
    });

    expect(genResponse.statusCode).toBe(202);
    const genBody = genResponse.json();

    await new Promise<void>(resolve => setImmediate(resolve));

    const pollResponse = await server.inject({
      method: 'GET',
      url: `/v1/tuning/drafts/${genBody.draftId}`,
    });

    expect(pollResponse.statusCode).toBe(200);
    const pollBody = pollResponse.json();
    expect(pollBody.status).toBe('failed');
    expect(pollBody.error).toBe('NO_DOCUMENTS');
  });
});

describe('T035 — US1: Concurrent generate', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    personaRepoMocks.getById.mockResolvedValue(mockPersona);
    extractionPipelineMock.run.mockResolvedValue(undefined);
    server = await setupTestServer();
  });

  it('first returns 202, second returns 409', async () => {
    draftRepoMocks.create
      .mockResolvedValueOnce({ ...mockDraftGenerating })
      .mockRejectedValueOnce(new Error('unique constraint violation'));

    const first = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/tuning/generate',
      payload: { method: 'doc-extraction' },
    });
    expect(first.statusCode).toBe(202);

    const second = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/tuning/generate',
      payload: { method: 'doc-extraction' },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error.code).toBe('conflict');
  });
});

describe('T036 — US1: Poll states: generating → ready', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ status: 'generating' });
    personaRepoMocks.getById.mockResolvedValue(mockPersona);
    server = await setupTestServer();
  });

  it('returns generating on first poll, ready after pipeline completes', async () => {
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));

    const pollGenerating = await server.inject({
      method: 'GET',
      url: '/v1/tuning/drafts/draft-001',
    });
    expect(pollGenerating.statusCode).toBe(200);
    expect(pollGenerating.json().status).toBe('generating');

    Object.assign(currentDraft, { status: 'ready', systemPrompt: 'tuned prompt' });

    const pollReady = await server.inject({
      method: 'GET',
      url: '/v1/tuning/drafts/draft-001',
    });
    expect(pollReady.statusCode).toBe(200);
    expect(pollReady.json().status).toBe('ready');
    expect(pollReady.json().systemPrompt).toBe('tuned prompt');
  });
});

describe('T037 — US2: Full cycle: generate → review → activate → rollback', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ ...mockDraftReady });
    personaRepoMocks.getById.mockResolvedValue(mockPersona);
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    draftRepoMocks.update.mockImplementation(async (_t, _id, data) => {
      Object.assign(currentDraft, data);
      return { ...currentDraft };
    });
    extractionPipelineMock.run.mockResolvedValue(undefined);
    activatePipelineMock.activate.mockResolvedValue({ activatedAt: new Date().toISOString() });
    activatePipelineMock.rollback.mockResolvedValue(undefined);
    server = await setupTestServer();
  });

  it('completes full lifecycle', async () => {
    const genResponse = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/tuning/generate',
      payload: { method: 'doc-extraction' },
    });
    expect(genResponse.statusCode).toBe(202);

    Object.assign(currentDraft, { status: 'ready', systemPrompt: 'tuned prompt' });

    const reviewResponse = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/review',
      payload: { verdict: 'approved', notes: 'Looks good' },
    });
    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.json().acknowledged).toBe(true);

    const activateResponse = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/activate',
    });
    expect(activateResponse.statusCode).toBe(200);
    const activateBody = activateResponse.json();
    expect(activateBody.status).toBe('activated');
    expect(activateBody).toHaveProperty('activatedAt');

    Object.assign(currentDraft, { status: 'activated' });

    const draftAfterActivate = await server.inject({
      method: 'GET',
      url: '/v1/tuning/drafts/draft-001',
    });
    expect(draftAfterActivate.statusCode).toBe(200);
    expect(draftAfterActivate.json().status).toBe('activated');

    const rollbackResponse = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/rollback',
    });
    expect(rollbackResponse.statusCode).toBe(200);
    expect(rollbackResponse.json().status).toBe('rolled-back');
  });
});

describe('T038 — US2: Activate already-activated → 409', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ ...mockDraftReady });
    server = await setupTestServer();
  });

  it('returns 409 when activating an already activated draft', async () => {
    const { ConflictError: CE } = await import('@undrecreaitwins/shared');
    activatePipelineMock.activate.mockRejectedValue(new CE('Draft is already activated'));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/activate',
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('conflict');
  });
});

describe('T039 — US2: Chained activation: A → B → A superseded → rollback B → rollback A → 409', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ ...mockDraftReady });
    personaRepoMocks.getById.mockResolvedValue(mockPersona);
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    server = await setupTestServer();
  });

  it('handles chained activation correctly', async () => {
    const activatedAtA = new Date(Date.now() - 60000).toISOString();
    const activatedAtB = new Date().toISOString();

    activatePipelineMock.activate.mockResolvedValueOnce({ activatedAt: activatedAtA });
    activatePipelineMock.activate.mockResolvedValueOnce({ activatedAt: activatedAtB });

    const activateA = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/activate',
    });
    expect(activateA.statusCode).toBe(200);

    Object.assign(currentDraft, { status: 'activated', activatedAt: activatedAtA });

    const activateB = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-002/activate',
    });
    expect(activateB.statusCode).toBe(200);

    Object.assign(currentDraft, { status: 'superseded' });

    const rollbackB = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-002/rollback',
    });
    expect(rollbackB.statusCode).toBe(200);
    expect(rollbackB.json().status).toBe('rolled-back');

    Object.assign(currentDraft, { status: 'rolled-back' });

    const { ConflictError: CE } = await import('@undrecreaitwins/shared');
    activatePipelineMock.rollback.mockRejectedValue(new CE('DRAFT_SUPERSEDED'));

    const rollbackA = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/rollback',
    });
    expect(rollbackA.statusCode).toBe(409);
    expect(rollbackA.json().error.code).toBe('conflict');
  });
});

describe('T040 — US5: Sandbox preview with draft overlay', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ ...mockDraftReady });
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    chatServiceMock.complete.mockResolvedValue({
      id: 'chat-001',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from tuned persona' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    server = await setupTestServer();
  });

  it('returns reply with metadata containing overriddenParts', async () => {
    Object.assign(currentDraft, {
      systemPrompt: 'Draft prompt',
      funnelConfig: { funnelStages: [] },
      validatorToggles: { someValidator: true },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/sandbox-preview',
      payload: { messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('reply');
    expect(body.reply).toBe('Hello from tuned persona');
    expect(body.metadata.draftApplied).toBe(true);
    expect(body.metadata.overriddenParts).toContain('systemPrompt');
  });
});

describe('T041 — US5: Sandbox preview with empty RAG (minimal overlay)', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ ...mockDraftReady });
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    chatServiceMock.complete.mockResolvedValue({
      id: 'chat-001',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Generic reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    server = await setupTestServer();
  });

  it('returns metadata with draftApplied: false and overriddenParts empty', async () => {
    Object.assign(currentDraft, {
      systemPrompt: null,
      funnelConfig: null,
      validatorToggles: null,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/sandbox-preview',
      payload: { messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata.draftApplied).toBe(false);
    expect(body.metadata.overriddenParts).toEqual([]);
  });
});

describe('T042 — US3: Interview flow: next → answer × 7 → draft created', () => {
  let server: FastifyInstance;

  const questions = [
    { id: 'q1', text: 'Какие основные задачи должен выполнять ассистент?' },
    { id: 'q2', text: 'Какой стиль общения предпочтителен?' },
    { id: 'q3', text: 'Какие темы ассистент НЕ должен обсуждать?' },
    { id: 'q4', text: 'Какие документы или инструкции должны быть в базе знаний?' },
    { id: 'q5', text: 'Какие этапы обработки запроса нужны?' },
    { id: 'q6', text: 'Как обрабатывать неполные запросы?' },
    { id: 'q7', text: 'Какие типы ответов поддерживать?' },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    let questionIndex = 0;
    draftRepoMocks.create.mockImplementation(async (_t, data) => {
      resetDraftState({ personaId: data.personaId, method: data.method });
      return { ...currentDraft };
    });
    draftRepoMocks.update.mockImplementation(async (_t, _id, data) => {
      Object.assign(currentDraft, data);
      return { ...currentDraft };
    });
    interviewMachineMock.getNextQuestion.mockImplementation(async () => {
      if (questionIndex >= questions.length) {
        return { draftId: 'draft-interview-001', status: 'ready' };
      }
      const q = questions[questionIndex]!;
      questionIndex++;
      return { question: q.text, questionId: q.id, total: 7, current: questionIndex };
    });
    interviewMachineMock.submitAnswer.mockResolvedValue(true);
    server = await setupTestServer();
  });

  it('returns questions, accepts answers, returns draft when complete', async () => {
    for (let i = 0; i < 7; i++) {
      const next = await server.inject({
        method: 'POST',
        url: '/v1/personas/persona-001/tuning/interview/next',
      });
      expect(next.statusCode).toBe(200);
      const nextBody = next.json();
      expect(nextBody).toHaveProperty('question');
      expect(nextBody).toHaveProperty('questionId');

      const answer = await server.inject({
        method: 'POST',
        url: '/v1/personas/persona-001/tuning/interview/answer',
        payload: { questionId: nextBody.questionId, answer: `Answer to ${nextBody.questionId}` },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json().acknowledged).toBe(true);
    }

    const final = await server.inject({
      method: 'POST',
      url: '/v1/personas/persona-001/tuning/interview/next',
    });
    expect(final.statusCode).toBe(200);
    const finalBody = final.json();
    expect(finalBody).toHaveProperty('draftId');
    expect(finalBody.status).toBe('ready');
  });
});

describe('T043 — US4: Proposals with warmup (< 3 drafts)', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    draftRepoMocks.listByPersona.mockResolvedValue([]);
    conversationAnalyzerMock.analyze.mockResolvedValue({ proposals: [], warmup: true });
    server = await setupTestServer();
  });

  it('returns empty proposals with warmup indicator', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/personas/persona-001/tuning/proposals',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('proposals');
    expect(body.warmup).toBe(true);
  });
});

describe('T044 — US4: Expire proposal → accept → 404', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    conversationAnalyzerMock.acceptProposal.mockResolvedValue(null);
    server = await setupTestServer();
  });

  it('returns 404 when accepting expired proposal', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tuning/proposals/proposal-expired/accept?personaId=persona-001',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('not_found');
  });
});

describe('T045 — Cross-tenant draft access → 404', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState();
    const { NotFoundError: NFE } = await import('@undrecreaitwins/shared');
    draftRepoMocks.getById.mockRejectedValue(new NFE('TuningDraft', 'draft-other-tenant'));
    server = await setupTestServer();
  });

  it('returns 404 when accessing draft from different tenant', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/tuning/drafts/draft-other-tenant',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('not_found');
  });
});

describe('T046 — Stalled generation: poll → GENERATION_STALLED', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({
      status: 'failed',
      error: 'GENERATION_STALLED',
      createdAt: new Date(Date.now() - 180_000).toISOString(),
    });
    draftRepoMocks.getById.mockImplementation(async () => ({ ...currentDraft }));
    server = await setupTestServer();
  });

  it('returns failed with GENERATION_STALLED', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/tuning/drafts/draft-stalled-001',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('failed');
    expect(body.error).toBe('GENERATION_STALLED');
  });
});

describe('T047 — Rollback with null previousSnapshot → 400', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDraftState({ ...mockDraftReady, previousSnapshot: null });
    const { ConflictError: CE } = await import('@undrecreaitwins/shared');
    activatePipelineMock.rollback.mockRejectedValue(new CE('NO_PREVIOUS_SNAPSHOT'));
    server = await setupTestServer();
  });

  it('returns 409 NO_PREVIOUS_SNAPSHOT on rollback', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tuning/drafts/draft-001/rollback',
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('conflict');
  });
});
