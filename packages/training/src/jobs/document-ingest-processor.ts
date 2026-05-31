import type { Job } from 'bullmq';
import { processDocumentIngest } from './document-ingest-worker.js';

export default async function(job: Job) {
  return processDocumentIngest(job);
}
