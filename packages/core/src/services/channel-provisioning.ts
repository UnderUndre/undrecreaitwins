import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { AppError, CHANNEL_TYPES } from '@undrecreaitwins/shared';
import { encryptApiKey } from './llm-provider/crypto.js';

const logger = pino({ name: 'channel-provisioning' });

const VALID_CHANNEL_SET = new Set<string>(CHANNEL_TYPES);

export interface ProvisionChannelInput {
  tenantId: string;
  personaSlug: string;
  channelType: string;
  credentials: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface ProvisionResult {
  channelId: string;
  ciphertext: string;
  kmsKeyRef: string;
  committed: boolean;
}

export async function provisionChannel(input: ProvisionChannelInput): Promise<ProvisionResult> {
  if (!input.tenantId || !input.personaSlug || !input.channelType) {
    throw new AppError(
      'tenantId, personaSlug, and channelType are required',
      400,
      'INVALID_INPUT',
    );
  }

  if (!VALID_CHANNEL_SET.has(input.channelType)) {
    throw new AppError(
      `Unsupported channel type: ${input.channelType}`,
      400,
      'UNSUPPORTED_CHANNEL_TYPE',
    );
  }

  const credentialsJson = JSON.stringify(input.credentials);
  const { ciphertext, keyRef } = await encryptApiKey(credentialsJson);
  const channelId = randomUUID();

  logger.info({ channelId, channelType: input.channelType, tenantId: input.tenantId, keyRef }, 'Channel provisioned');

  return { channelId, ciphertext, kmsKeyRef: keyRef, committed: false };
}
