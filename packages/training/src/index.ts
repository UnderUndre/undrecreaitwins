import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { TRAINING_QUEUE_NAME, DOCUMENT_QUEUE_NAME, LAZY_EMBED_QUEUE_NAME } from './jobs/queue.js';
import { processTrainingJob } from './jobs/training-job.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

console.log('Starting BullMQ workers...');

// 1. Training Worker (In-process for now, as it was before)
const trainingWorker = new Worker(TRAINING_QUEUE_NAME, processTrainingJob, {
  connection,
  concurrency: 2,
});

// 2. Document Ingest Worker (Sandboxed to protect event loop - gemini F3)
const documentWorker = new Worker(
  DOCUMENT_QUEUE_NAME,
  path.join(__dirname, 'jobs', 'document-ingest-processor.js'),
  {
    connection,
    concurrency: 5,
  }
);

// 3. Lazy Embed Worker (Sandboxed to protect event loop)
const lazyEmbedWorker = new Worker(
  LAZY_EMBED_QUEUE_NAME,
  path.join(__dirname, 'jobs', 'lazy-embed-processor.js'),
  {
    connection,
    concurrency: 2,
  }
);

trainingWorker.on('completed', (job) => {
  console.log(`Training job ${job.id} completed`);
});

trainingWorker.on('failed', (job, err) => {
  console.error(`Training job ${job?.id} failed:`, err);
});

documentWorker.on('completed', (job) => {
  console.log(`Document ingest job ${job.id} completed`);
});

documentWorker.on('failed', (job, err) => {
  console.error(`Document ingest job ${job?.id} failed:`, err);
});

lazyEmbedWorker.on('completed', (job) => {
  console.log(`Lazy embed job ${job.id} completed`);
});

lazyEmbedWorker.on('failed', (job, err) => {
  console.error(`Lazy embed job ${job?.id} failed:`, err);
});

process.on('SIGTERM', async () => {
  console.log('Stopping workers...');
  await trainingWorker.close();
  await documentWorker.close();
  await lazyEmbedWorker.close();
  await connection.quit();
  process.exit(0);
});
