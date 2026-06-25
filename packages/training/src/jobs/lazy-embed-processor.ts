import type { Job } from 'bullmq';
import { processLazyEmbed } from './lazy-embed-worker.js';

export default async function(job: Job) {
  return processLazyEmbed(job);
}
