import { AppError } from '@undrecreaitwins/shared';
import pino from 'pino';

const logger = pino({ name: 'honcho-client' });

export interface HonchoInsight {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

type ErrorClass = 'transient' | 'permanent';
export type DegradationSignal = (cls: ErrorClass, context: Record<string, unknown>) => void;

let degradationSignal: DegradationSignal = () => {};

export function setDegradationSignal(fn: DegradationSignal): void {
  degradationSignal = fn;
}

interface ResolvedIds {
  workspaceId: string;
  peers: Map<string, string>;
  sessions: Map<string, string>;
}

export class HonchoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly cache: Map<string, ResolvedIds> = new Map();
  private static readonly MAX_CACHE_SIZE = 512;

  constructor() {
    const url = process.env.HONCHO_URL;
    if (!url) {
      throw new AppError('HONCHO_URL is required', 500, 'configuration_error');
    }
    this.baseUrl = url;
    this.apiKey = process.env.HONCHO_API_KEY || undefined;
  }

  private v3Url(path: string): string {
    return `${this.baseUrl}/v3${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private peerId(personaId: string, externalUserId?: string): string {
    return externalUserId ? `p-${personaId}-u-${externalUserId}` : `p-${personaId}`;
  }

  private classifyError(err: unknown, statusCode?: number): ErrorClass {
    if (statusCode) {
      if (statusCode === 404 || statusCode === 422) return 'permanent';
      if (statusCode >= 400 && statusCode < 500) return 'permanent';
      if (statusCode >= 500) return 'transient';
    }
    const code = err && typeof err === 'object' ? ((err as any).code || (err as any).cause?.code) : undefined;
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      return 'transient';
    }
    return 'transient';
  }

  private signalDegraded(cls: ErrorClass, context: Record<string, unknown>): void {
    if (cls === 'permanent') {
      logger.error({ ...context, class: cls }, 'honcho API mismatch (permanent)');
    } else {
      logger.warn({ ...context, class: cls }, 'honcho degraded (transient)');
    }
    try {
      degradationSignal(cls, context);
    } catch {}
  }

  private async ensureWorkspace(tenantId: string): Promise<string> {
    const cached = this.cache.get(tenantId);
    if (cached?.workspaceId) return cached.workspaceId;

    const wsId = await this.getOrCreate(
      `/workspaces`,
      { id: tenantId },
      tenantId,
    );

    if (!this.cache.has(tenantId)) {
      if (this.cache.size >= HonchoClient.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
      this.cache.set(tenantId, { workspaceId: wsId, peers: new Map(), sessions: new Map() });
    } else {
      this.cache.get(tenantId)!.workspaceId = wsId;
    }
    return wsId;
  }

  private async ensurePeer(tenantId: string, peerKey: string): Promise<string> {
    const cached = this.cache.get(tenantId);
    if (cached?.peers.has(peerKey)) return cached.peers.get(peerKey)!;

    await this.ensureWorkspace(tenantId);
    const peerId = await this.getOrCreate(
      `/workspaces/${encodeURIComponent(tenantId)}/peers`,
      { id: peerKey },
      peerKey,
    );

    const entry = this.cache.get(tenantId) || { workspaceId: tenantId, peers: new Map(), sessions: new Map() };
    entry.peers.set(peerKey, peerId);
    if (!this.cache.has(tenantId)) this.cache.set(tenantId, entry);
    return peerId;
  }

  private async ensureSessionEntity(tenantId: string, peerKey: string, sessionId: string): Promise<string> {
    const cacheKey = `${tenantId}:${sessionId}`;
    const cached = this.cache.get(tenantId);
    if (cached?.sessions.has(cacheKey)) return cached.sessions.get(cacheKey)!;

    await this.ensureWorkspace(tenantId);
    await this.ensurePeer(tenantId, peerKey);

    const sessId = await this.getOrCreate(
      `/workspaces/${encodeURIComponent(tenantId)}/sessions`,
      { id: sessionId },
      sessionId,
    );

    await this.doFetch(
      `/workspaces/${encodeURIComponent(tenantId)}/sessions/${encodeURIComponent(sessId)}/peers`,
      {
        method: 'POST',
        body: JSON.stringify({ peer_id: peerKey }),
      },
    ).catch(() => {});

    const entry = this.cache.get(tenantId) || { workspaceId: tenantId, peers: new Map(), sessions: new Map() };
    entry.sessions.set(cacheKey, sessId);
    if (!this.cache.has(tenantId)) this.cache.set(tenantId, entry);
    return sessId;
  }

  private async getOrCreate(path: string, body: Record<string, unknown>, fallbackId: string): Promise<string> {
    const res = await this.doFetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      return fallbackId;
    }

    if (res.ok) {
      const data: any = await res.json();
      return data.id || fallbackId;
    }

    if (res.status === 404) {
      return fallbackId;
    }

    return fallbackId;
  }

  private async doFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(this.v3Url(path), {
      ...options,
      headers: { ...this.headers(), ...(options.headers as Record<string, string> || {}) },
    });
  }

  async getInsights(tenantId: string, personaId: string, externalUserId?: string): Promise<HonchoInsight[]> {
    try {
      const peerKey = this.peerId(personaId, externalUserId);
      await this.ensureWorkspace(tenantId);

      const res = await this.doFetch(
        `/workspaces/${encodeURIComponent(tenantId)}/peers/${encodeURIComponent(peerKey)}/representation`,
      );

      if (!res.ok) {
        const cls = this.classifyError(null, res.status);
        this.signalDegraded(cls, { tenantId, personaId, status: res.status });
        return [];
      }

      const data: any = await res.json();
      if (Array.isArray(data)) {
        return data.map((item: any) => ({
          id: item.id || '',
          content: item.content || '',
          metadata: item.metadata,
        }));
      }

      if (data?.content) {
        return [{ id: data.id || '', content: data.content, metadata: data.metadata }];
      }

      return [];
    } catch (err) {
      const cls = this.classifyError(err);
      this.signalDegraded(cls, { tenantId, personaId, err });
      return [];
    }
  }

  async addMessage(
    tenantId: string,
    personaId: string,
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    externalUserId?: string,
  ): Promise<void> {
    try {
      const peerKey = this.peerId(personaId, externalUserId);
      await this.ensureSessionEntity(tenantId, peerKey, sessionId);

      const res = await this.doFetch(
        `/workspaces/${encodeURIComponent(tenantId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ content, role }),
        },
      );
      if (!res.ok) {
        throw new Error(`Honcho addMessage failed with status ${res.status}`);
      }
    } catch (err) {
      const cls = this.classifyError(err);
      this.signalDegraded(cls, { tenantId, personaId, sessionId, err });
    }
  }

  async ensureSession(
    tenantId: string,
    personaId: string,
    sessionId: string,
    externalUserId?: string,
  ): Promise<void> {
    try {
      const peerKey = this.peerId(personaId, externalUserId);
      await this.ensureSessionEntity(tenantId, peerKey, sessionId);
    } catch (err) {
      const cls = this.classifyError(err);
      this.signalDegraded(cls, { tenantId, personaId, sessionId, err });
    }
  }
}
