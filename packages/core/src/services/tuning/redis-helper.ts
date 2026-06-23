import type { Redis } from 'ioredis';

interface StoreEntry<T> {
  value: T;
  expiresAt: number;
}

export class RedisHelper {
  private redis: Redis | null = null;
  private fallbackStore: Map<string, StoreEntry<any>> = new Map();
  private fallbackMode = false;

  constructor() {
    const url = process.env.TUNING_REDIS_URL || process.env.REDIS_URL;
    if (url) {
      try {
        // Dynamic import to allow graceful fallback if ioredis fails to load
        const Redis = require('ioredis').default as typeof import('ioredis').default;
        this.redis = new Redis(url);
      } catch {
        this.fallbackMode = true;
      }
    } else {
      this.fallbackMode = true;
    }

    if (this.fallbackMode) {
      setInterval(() => this.cleanup(), 60_000).unref();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.fallbackStore) {
      if (entry.expiresAt <= now) {
        this.fallbackStore.delete(key);
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.fallbackMode) {
      const entry = this.fallbackStore.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        this.fallbackStore.delete(key);
        return null;
      }
      return entry.value as T;
    }
    const data = await this.redis!.get(key);
    return data ? JSON.parse(data) : null;
  }

  async set(key: string, value: any, ttlSeconds = 1800): Promise<void> {
    if (this.fallbackMode) {
      this.fallbackStore.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return;
    }
    await this.redis!.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    if (this.fallbackMode) {
      this.fallbackStore.delete(key);
      return;
    }
    await this.redis!.del(key);
  }

  async updateArray<T>(key: string, predicate: (item: T) => boolean): Promise<void> {
    const arr = await this.get<T[]>(key);
    if (!arr) return;
    const filtered = arr.filter((item) => !predicate(item));
    await this.set(key, filtered);
  }

  interviewKey(tenantId: string, personaId: string, userId: string): string {
    return `tuning:interview:${tenantId}:${personaId}:${userId}`;
  }

  proposalsKey(tenantId: string, personaId: string): string {
    return `tuning:proposals:${tenantId}:${personaId}`;
  }
}

export const redisHelper = new RedisHelper();
