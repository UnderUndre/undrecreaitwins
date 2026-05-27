import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export interface StorageBackend {
  save(key: string, data: Buffer): Promise<string>;
  saveStream(key: string, stream: NodeJS.ReadableStream): Promise<string>;
  read(ref: string): Promise<Buffer>;
  remove(ref: string): Promise<void>;
}

export function createStorageBackend(): StorageBackend {
  const backend = process.env.TWIN_STORAGE_BACKEND || 'local-fs';

  switch (backend) {
    case 'local-fs':
      return new LocalFsStorage();
    case 'shared-volume':
      return new SharedVolumeStorage();
    case 's3':
      return new S3Storage();
    default:
      return new LocalFsStorage();
  }
}

async function saveBufferToDir(baseDir: string, key: string, data: Buffer): Promise<string> {
  if (!existsSync(baseDir)) {
    await mkdir(baseDir, { recursive: true });
  }
  const ref = join(baseDir, key);
  await writeFile(ref, data);
  return ref;
}

async function saveStreamToDir(
  baseDir: string,
  key: string,
  stream: NodeJS.ReadableStream,
): Promise<string> {
  if (!existsSync(baseDir)) {
    await mkdir(baseDir, { recursive: true });
  }
  const ref = join(baseDir, key);
  const target = createWriteStream(ref);
  try {
    await pipeline(stream, target);
  } catch (err) {
    try { await unlink(ref); } catch {}
    throw err;
  }
  return ref;
}

class LocalFsStorage implements StorageBackend {
  private baseDir = process.env.TWIN_UPLOAD_DIR || '/tmp/twin-uploads';

  save(key: string, data: Buffer): Promise<string> {
    return saveBufferToDir(this.baseDir, key, data);
  }

  saveStream(key: string, stream: NodeJS.ReadableStream): Promise<string> {
    return saveStreamToDir(this.baseDir, key, stream);
  }

  async read(ref: string): Promise<Buffer> {
    return readFile(ref);
  }

  async remove(ref: string): Promise<void> {
    try {
      await unlink(ref);
    } catch {}
  }
}

class SharedVolumeStorage implements StorageBackend {
  private baseDir = process.env.TWIN_SHARED_VOLUME_PATH || '/data/twin-uploads';

  save(key: string, data: Buffer): Promise<string> {
    return saveBufferToDir(this.baseDir, key, data);
  }

  saveStream(key: string, stream: NodeJS.ReadableStream): Promise<string> {
    return saveStreamToDir(this.baseDir, key, stream);
  }

  async read(ref: string): Promise<Buffer> {
    return readFile(ref);
  }

  async remove(ref: string): Promise<void> {
    try {
      await unlink(ref);
    } catch {}
  }
}

class S3Storage implements StorageBackend {
  async save(_key: string, _data: Buffer): Promise<string> {
    throw new Error('S3 storage backend requires @aws-sdk/client-s3. Install and configure TWIN_S3_* env vars.');
  }

  async saveStream(_key: string, _stream: NodeJS.ReadableStream): Promise<string> {
    throw new Error('S3 storage backend requires @aws-sdk/client-s3. Install and configure TWIN_S3_* env vars.');
  }

  async read(_ref: string): Promise<Buffer> {
    throw new Error('S3 storage backend not implemented in v1');
  }

  async remove(_ref: string): Promise<void> {
    throw new Error('S3 storage backend not implemented in v1');
  }
}
