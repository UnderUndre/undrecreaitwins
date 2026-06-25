import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { TrainingSourceType } from '@undrecreaitwins/shared';

export const TRAINING_QUEUE_NAME = 'training';
export const TRAINING_JOB_NAME = 'process';
export const DOCUMENT_QUEUE_NAME = 'document-ingestion';
export const DOCUMENT_JOB_NAME = 'ingest';
export const LAZY_EMBED_QUEUE_NAME = 'lazy-embed';
export const LAZY_EMBED_JOB_NAME = 'embed';

export interface TrainingJobData {
  tenantId: string;
  personaId: string;
  sourceType: TrainingSourceType;
  sourceFileRef: string;
  jobId: string;
}

export interface DocumentJobData {
  documentId: string;
  tenantId: string;
  personaId: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface LazyEmbedJobData {
  tenantId: string;
  personaId: string;
}

let queue: Queue<TrainingJobData> | null = null;
let documentQueue: Queue<DocumentJobData> | null = null;
let lazyEmbedQueue: Queue<LazyEmbedJobData> | null = null;
let connection: Redis | undefined;

function getConnection(): Redis {
  if (connection) return connection;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  connection = new Redis(url, { maxRetriesPerRequest: null });
  return connection;
}

export function getTrainingQueue(): Queue<TrainingJobData> {
  if (queue) return queue;
  queue = new Queue<TrainingJobData>(TRAINING_QUEUE_NAME, {
    connection: getConnection(),
  });
  return queue;
}

export function getDocumentQueue(): Queue<DocumentJobData> {
  if (documentQueue) return documentQueue;
  documentQueue = new Queue<DocumentJobData>(DOCUMENT_QUEUE_NAME, {
    connection: getConnection(),
  });
  return documentQueue;
}

export function getLazyEmbedQueue(): Queue<LazyEmbedJobData> {
  if (lazyEmbedQueue) return lazyEmbedQueue;
  lazyEmbedQueue = new Queue<LazyEmbedJobData>(LAZY_EMBED_QUEUE_NAME, {
    connection: getConnection(),
  });
  return lazyEmbedQueue;
}

export async function enqueueTrainingJob(data: TrainingJobData): Promise<void> {
  await getTrainingQueue().add(TRAINING_JOB_NAME, data, {
    jobId: data.jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  });
}

export async function enqueueLazyEmbedJob(data: LazyEmbedJobData): Promise<void> {
  await getLazyEmbedQueue().add(LAZY_EMBED_JOB_NAME, data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  });
}

export async function closeTrainingQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (documentQueue) {
    await documentQueue.close();
    documentQueue = null;
  }
  if (lazyEmbedQueue) {
    await lazyEmbedQueue.close();
    lazyEmbedQueue = null;
  }
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
}
