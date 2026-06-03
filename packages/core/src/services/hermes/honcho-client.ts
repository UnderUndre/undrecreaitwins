import { AppError } from '@undrecreaitwins/shared';
import pino from 'pino';

const logger = pino();

export interface HonchoInsight {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export class HonchoClient {
  private readonly baseUrl: string;

  constructor() {
    const url = process.env.HONCHO_URL;
    if (!url) {
      throw new AppError('HONCHO_URL is required', 500, 'configuration_error');
    }
    this.baseUrl = url;
  }

  private appId(tenantId: string): string {
    return `t-${tenantId}`;
  }

  private userId(personaId: string, externalUserId?: string): string {
    return externalUserId ? `p-${personaId}-u-${externalUserId}` : `p-${personaId}`;
  }

  async getInsights(tenantId: string, personaId: string, externalUserId?: string): Promise<HonchoInsight[]> {
    try {
      const appId = encodeURIComponent(this.appId(tenantId));
      const userId = encodeURIComponent(this.userId(personaId, externalUserId));
      const res = await fetch(`${this.baseUrl}/apps/${appId}/users/${userId}/insights`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      logger.warn({ err, tenantId, personaId }, 'Honcho getInsights failed, degrading gracefully');
      return [];
    }
  }

  async addMessage(tenantId: string, personaId: string, sessionId: string, role: 'user' | 'assistant', content: string, externalUserId?: string): Promise<void> {
    try {
      const appId = encodeURIComponent(this.appId(tenantId));
      const userId = encodeURIComponent(this.userId(personaId, externalUserId));
      const encSessionId = encodeURIComponent(sessionId);
      await fetch(`${this.baseUrl}/apps/${appId}/users/${userId}/sessions/${encSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, role }),
      });
    } catch (err) {
      logger.warn({ err, tenantId, personaId, sessionId }, 'Honcho addMessage failed, degrading gracefully');
    }
  }

  async ensureSession(tenantId: string, personaId: string, sessionId: string, externalUserId?: string): Promise<void> {
    try {
      const appId = encodeURIComponent(this.appId(tenantId));
      const userId = encodeURIComponent(this.userId(personaId, externalUserId));
      const encSessionId = encodeURIComponent(sessionId);
      await fetch(`${this.baseUrl}/apps/${appId}/users/${userId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: encSessionId }),
      });
    } catch (err) {
      logger.warn({ err, tenantId, personaId, sessionId }, 'Honcho ensureSession failed, degrading gracefully');
    }
  }
}
