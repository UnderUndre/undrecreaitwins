/**
 * crypto.ts — KMS-envelope encrypt/decrypt for API keys.
 *
 * - Envelope: KMS-managed KEK wraps per-record data key
 * - Decrypt only at injection time (never at rest, never in logs)
 * - KMS failure triggers BullMQ retry (typed error)
 * - No plaintext in logs/traces
 */
import pino from 'pino';

const logger = pino({ name: 'llm-provider-crypto' });

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class KmsUnavailableError extends Error {
  public readonly name = 'KmsUnavailableError';
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    Object.setPrototypeOf(this, KmsUnavailableError.prototype);
  }
}

export class KmsEncryptionError extends Error {
  public readonly name = 'KmsEncryptionError';
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    Object.setPrototypeOf(this, KmsEncryptionError.prototype);
  }
}

// ---------------------------------------------------------------------------
// KmsProvider interface
// ---------------------------------------------------------------------------

export interface KmsProvider {
  /** Encrypt a plaintext string, returning ciphertext and the key reference used. */
  encrypt(plaintext: string): Promise<{ ciphertext: string; keyRef: string }>;
  /** Decrypt ciphertext that was encrypted with the given keyRef. */
  decrypt(ciphertext: string, keyRef: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// LocalKmsProvider (dev / test)
// ---------------------------------------------------------------------------

const LOCAL_PREFIX = 'local:';

let localWarned = false;

export class LocalKmsProvider implements KmsProvider {
  public async encrypt(plaintext: string): Promise<{ ciphertext: string; keyRef: string }> {
    if (!localWarned) {
      logger.warn(
        'LocalKmsProvider active — keys are only base64-obfuscated, NOT cryptographically secure. ' +
          'Set KMS_PROVIDER=aws for production.',
      );
      localWarned = true;
    }
    const ciphertext = LOCAL_PREFIX + Buffer.from(plaintext, 'utf-8').toString('base64');
    const keyRef = process.env.KMS_KEY_ID ?? 'local-default-key';
    return { ciphertext, keyRef };
  }

  public async decrypt(ciphertext: string, _keyRef: string): Promise<string> {
    if (!ciphertext.startsWith(LOCAL_PREFIX)) {
      throw new KmsEncryptionError('LocalKmsProvider: invalid ciphertext prefix');
    }
    const b64 = ciphertext.slice(LOCAL_PREFIX.length);
    try {
      return Buffer.from(b64, 'base64').toString('utf-8');
    } catch (err) {
      throw new KmsEncryptionError('LocalKmsProvider: base64 decode failed', err);
    }
  }
}

// ---------------------------------------------------------------------------
// AwsKmsProvider stub
// ---------------------------------------------------------------------------

export class AwsKmsProvider implements KmsProvider {
  public async encrypt(_plaintext: string): Promise<{ ciphertext: string; keyRef: string }> {
    // TODO: real AWS KMS SDK integration
    throw new KmsUnavailableError(
      'AwsKmsProvider is not yet implemented. Set KMS_PROVIDER=local for development.',
    );
  }

  public async decrypt(_ciphertext: string, _keyRef: string): Promise<string> {
    // TODO: real AWS KMS SDK integration
    throw new KmsUnavailableError(
      'AwsKmsProvider is not yet implemented. Set KMS_PROVIDER=local for development.',
    );
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

let cachedProvider: KmsProvider | null = null;

export function kmsProviderFactory(): KmsProvider {
  if (cachedProvider) return cachedProvider;

  const provider = (process.env.KMS_PROVIDER ?? 'local').toLowerCase();

  switch (provider) {
    case 'aws':
      cachedProvider = new AwsKmsProvider();
      break;
    case 'local':
    default:
      cachedProvider = new LocalKmsProvider();
      break;
  }

  return cachedProvider;
}

/** Reset cached provider (useful for tests that change env vars). */
export function resetKmsProvider(): void {
  cachedProvider = null;
}

// ---------------------------------------------------------------------------
// Public envelope API
// ---------------------------------------------------------------------------

export interface KmsEnvelopeResult {
  /** base64-encoded encrypted API key */
  ciphertext: string;
  /** KMS key id / version for rotation */
  keyRef: string;
}

/**
 * Encrypt a plaintext API key using envelope encryption.
 * Returns ciphertext + keyRef suitable for storage in Postgres.
 */
export async function encryptApiKey(plaintext: string): Promise<KmsEnvelopeResult> {
  try {
    const provider = kmsProviderFactory();
    const result = await provider.encrypt(plaintext);
    // Never log plaintext or ciphertext
    logger.debug({ keyRef: result.keyRef }, 'encryptApiKey: success');
    return result;
  } catch (err) {
    if (err instanceof KmsUnavailableError) throw err;
    throw new KmsEncryptionError('encryptApiKey failed', err);
  }
}

/**
 * Decrypt an encrypted API key. Called ONLY at injection time.
 * Never log the returned plaintext.
 */
export async function decryptApiKey(ciphertext: string, keyRef: string): Promise<string> {
  try {
    const provider = kmsProviderFactory();
    const plaintext = await provider.decrypt(ciphertext, keyRef);
    logger.debug({ keyRef }, 'decryptApiKey: success');
    return plaintext;
  } catch (err) {
    if (err instanceof KmsUnavailableError) throw err;
    throw new KmsEncryptionError('decryptApiKey failed', err);
  }
}
