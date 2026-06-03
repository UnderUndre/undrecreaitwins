import type { Redis } from 'ioredis';
export interface AgentState {
  tenantId: string;
  personaId: string;
  conversationId?: string;
  hermesSessionId: string;
  status: 'warm' | 'cold' | 'hibernating';
  lastActivityAt: number;
}

const WARM_POOL_KEY = 'hermes:warm-pool';
const IDLE_TTL_MS = 15 * 60 * 1000;

function safeParse(raw: string): AgentState | null {
  try {
    return JSON.parse(raw) as AgentState;
  } catch {
    return null;
  }
}

function stateKey(tenantId: string, personaId: string, conversationId?: string): string {
  const conv = conversationId ?? '_none';
  return `${WARM_POOL_KEY}:${tenantId}:${personaId}:${conv}`;
}

export class AgentLifecycle {
  constructor(private readonly redis: Redis) {}

  async getState(tenantId: string, personaId: string, conversationId?: string): Promise<AgentState | null> {
    const raw = await this.redis.get(stateKey(tenantId, personaId, conversationId));
    return raw ? safeParse(raw) : null;
  }

  async spawn(tenantId: string, personaId: string, hermesSessionId: string, conversationId?: string): Promise<AgentState> {
    const state: AgentState = {
      tenantId,
      personaId,
      conversationId,
      hermesSessionId,
      status: 'warm',
      lastActivityAt: Date.now(),
    };
    await this.redis.set(stateKey(tenantId, personaId, conversationId), JSON.stringify(state), 'PX', IDLE_TTL_MS);
    return state;
  }

  async touch(tenantId: string, personaId: string, conversationId?: string): Promise<void> {
    const state = await this.getState(tenantId, personaId, conversationId);
    if (state) {
      state.lastActivityAt = Date.now();
      state.status = 'warm';
      await this.redis.set(stateKey(tenantId, personaId, conversationId), JSON.stringify(state), 'PX', IDLE_TTL_MS);
    }
  }

  async hibernate(tenantId: string, personaId: string, conversationId?: string): Promise<void> {
    const state = await this.getState(tenantId, personaId, conversationId);
    if (state) {
      state.status = 'hibernating';
      await this.redis.set(stateKey(tenantId, personaId, conversationId), JSON.stringify(state), 'PX', IDLE_TTL_MS * 2);
    }
  }

  async evict(tenantId: string, personaId: string, conversationId?: string): Promise<void> {
    await this.redis.del(stateKey(tenantId, personaId, conversationId));
  }

  async listWarm(): Promise<AgentState[]> {
    const keys: string[] = [];
    let cursor = '0';
    const match = `${WARM_POOL_KEY}:*`;

    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length === 0) return [];
    const values = await this.redis.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(safeParse)
      .filter((s): s is AgentState => s !== null);
  }
}
