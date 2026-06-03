export interface HonchoInsight {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export class HonchoClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = process.env.HONCHO_URL || 'http://localhost:8081';
  }

  private appId(tenantId: string): string {
    return `t-${tenantId}`;
  }

  private userId(personaId: string, externalUserId?: string): string {
    return externalUserId ? `p-${personaId}-u-${externalUserId}` : `p-${personaId}`;
  }

  async getInsights(tenantId: string, personaId: string, externalUserId?: string): Promise<HonchoInsight[]> {
    try {
      const appId = this.appId(tenantId);
      const userId = this.userId(personaId, externalUserId);
      const res = await fetch(`${this.baseUrl}/apps/${appId}/users/${userId}/insights`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async addMessage(tenantId: string, personaId: string, sessionId: string, role: 'user' | 'assistant', content: string, externalUserId?: string): Promise<void> {
    try {
      const appId = this.appId(tenantId);
      const userId = this.userId(personaId, externalUserId);
      await fetch(`${this.baseUrl}/apps/${appId}/users/${userId}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, role }),
      });
    } catch {}
  }

  async ensureSession(tenantId: string, personaId: string, sessionId: string, externalUserId?: string): Promise<void> {
    try {
      const appId = this.appId(tenantId);
      const userId = this.userId(personaId, externalUserId);
      await fetch(`${this.baseUrl}/apps/${appId}/users/${userId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId }),
      });
    } catch {}
  }
}
