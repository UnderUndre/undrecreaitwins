import type { Job } from 'bullmq';
import { parseTelegramJson } from '../parsers/telegram-json.js';
import { parseWhatsappTxt } from '../parsers/whatsapp-txt.js';
import { parseGenericJsonl } from '../parsers/generic-jsonl.js';
import { extractTraits } from '../extractors/trait-extractor.js';
import type { TrainingSourceType } from '@undrecreaitwins/shared';
import type { ParsedMessage } from '../parsers/telegram-json.js';

interface TrainingJobData {
  tenantId: string;
  personaId: string;
  sourceType: TrainingSourceType;
  sourceFileRef: string;
  jobId: string;
}

export async function processTrainingJob(job: Job<TrainingJobData>): Promise<void> {
  const { sourceType, sourceFileRef } = job.data;

  await job.updateProgress(10);

  const messages: ParsedMessage[] = [];
  const parser = getParser(sourceType);
  for await (const msg of parser(sourceFileRef)) {
    messages.push(msg);
  }

  await job.updateProgress(50);

  if (messages.length === 0) {
    throw new Error('No messages found in training file');
  }

  const traits = extractTraits(messages);

  await job.updateProgress(80);

  await job.updateProgress(100);

  job.returnvalue = {
    traits,
    messageCount: messages.length,
  };
}

function getParser(sourceType: TrainingSourceType): (path: string) => AsyncGenerator<ParsedMessage> {
  switch (sourceType) {
    case 'telegram_json':
      return parseTelegramJson;
    case 'whatsapp_txt':
      return parseWhatsappTxt;
    case 'generic_jsonl':
      return parseGenericJsonl;
    default:
      throw new Error(`Unknown source type: ${sourceType}`);
  }
}
