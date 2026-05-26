import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export interface StorageBackend {
  save(key: string, data: Buffer): Promise<string>;
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

class LocalFsStorage implements StorageBackend {
  private baseDir = process.env.TWIN_UPLOAD_DIR || '/tmp/twin-uploads';

  async save(key: string, data: Buffer): Promise<string> {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }
    const ref = join(this.baseDir, key);
    await writeFile(ref, data);
    return ref;
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

  async save(key: string, data: Buffer): Promise<string> {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }
    const ref = join(this.baseDir, key);
    await writeFile(ref, data);
    return ref;
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

  async read(_ref: string): Promise<Buffer> {
    throw new Error('S3 storage backend not implemented in v1');
  }

  async remove(_ref: string): Promise<void> {
    throw new Error('S3 storage backend not implemented in v1');
  }
}
