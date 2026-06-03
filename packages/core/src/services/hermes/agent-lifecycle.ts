import type { Redis } from 'ioredis';

export interface AgentState {
  tenantId: string;
  personaId: string;
  hermesSessionId: string;
  status: 'warm' | 'cold' | 'hibernating';
  lastActivityAt: number;
}

const WARM_POOL_KEY = 'hermes:warm-pool';
const IDLE_TTL_MS = 15 * 60 * 1000;

export class AgentLifecycle {
  constructor(private readonly redis: Redis) {}

  async getState(personaId: string): Promise<AgentState | null> {
    const raw = await this.redis.get(`${WARM_POOL_KEY}:${personaId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async spawn(tenantId: string, personaId: string, hermesSessionId: string): Promise<AgentState> {
    const state: AgentState = {
      tenantId,
      personaId,
      hermesSessionId,
      status: 'warm',
      lastActivityAt: Date.now(),
    };
    await this.redis.set(`${WARM_POOL_KEY}:${personaId}`, JSON.stringify(state), 'PX', IDLE_TTL_MS);
    return state;
  }

  async touch(personaId: string): Promise<void> {
    const state = await this.getState(personaId);
    if (state) {
      state.lastActivityAt = Date.now();
      state.status = 'warm';
      await this.redis.set(`${WARM_POOL_KEY}:${personaId}`, JSON.stringify(state), 'PX', IDLE_TTL_MS);
    }
  }

  async hibernate(personaId: string): Promise<void> {
    const state = await this.getState(personaId);
    if (state) {
      state.status = 'hibernating';
      await this.redis.set(`${WARM_POOL_KEY}:${personaId}`, JSON.stringify(state), 'PX', IDLE_TTL_MS * 2);
    }
  }

  async evict(personaId: string): Promise<void> {
    await this.redis.del(`${WARM_POOL_KEY}:${personaId}`);
  }

  async listWarm(): Promise<AgentState[]> {
    const keys = await this.redis.keys(`${WARM_POOL_KEY}:*`);
    if (keys.length === 0) return [];
    const values = await this.redis.mget(...keys);
    return values.filter((v): v is string => v !== null).map(v => JSON.parse(v));
  }
}
