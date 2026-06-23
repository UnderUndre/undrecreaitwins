import { z } from 'zod';

export const tuningMethodEnum = z.enum(['doc-extraction', 'template-bootstrap', 'interview', 'self-tuner']);
export const reviewVerdictEnum = z.enum(['approved', 'rejected']);
export const tuningDraftStatusEnum = z.enum(['generating', 'ready', 'failed', 'activated', 'superseded', 'rolled-back']);

export const GenerateRequest = z.object({
  method: tuningMethodEnum,
  options: z.object({
    templateId: z.string().optional(),
    conversationIds: z.array(z.string()).optional(),
  }).optional(),
});

export const ReviewRequest = z.object({
  verdict: reviewVerdictEnum,
  notes: z.string().optional(),
});

export const InterviewAnswerRequest = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export const SandboxPreviewRequest = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).min(1),
});

export const ProposalAcceptRequest = z.object({
});
