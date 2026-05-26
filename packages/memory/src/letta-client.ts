interface LettaConfig {
  baseUrl: string;
  timeout: number;
}

interface LettaAgent {
  id: string;
  name: string;
}

interface LettaMemory {
  id: string;
  content: string;
  type: 'human' | 'persona' | 'archival';
}

export class LettaClient {
  private config: LettaConfig;
  private available = true;
  private consecutiveFailures = 0;
  private lastFailureAt = 0;

  private static readonly MAX_FAILURES = 5;
  private static readonly HALF_OPEN_INTERVAL_MS = 60_000;

  constructor(config?: Partial<LettaConfig>) {
    this.config = {
      baseUrl: config?.baseUrl || process.env.LETTA_BASE_URL || 'http://localhost:8283',
      timeout: config?.timeout || parseInt(process.env.LETTA_TIMEOUT_MS || '2000', 10),
    };
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    if (!this.available) {
      const timeSinceFailure = Date.now() - this.lastFailureAt;
      if (timeSinceFailure < LettaClient.HALF_OPEN_INTERVAL_MS) {
        throw new Error('Letta circuit breaker open');
      }
      this.available = true;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Letta API error: ${response.status}`);
      }

      this.consecutiveFailures = 0;
      return response.json() as Promise<T>;
    } catch (error) {
      this.consecutiveFailures++;
      this.lastFailureAt = Date.now();
      if (this.consecutiveFailures >= LettaClient.MAX_FAILURES) {
        this.available = false;
      }
      throw error;
    }
  }

  async createAgent(name: string, systemPrompt: string): Promise<LettaAgent> {
    return this.request<LettaAgent>('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({ name, description: systemPrompt }),
    });
  }

  async getAgent(agentId: string): Promise<LettaAgent> {
    return this.request<LettaAgent>(`/v1/agents/${agentId}`);
  }

  async addMessage(agentId: string, role: string, content: string): Promise<unknown> {
    return this.request(`/v1/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role, content }] }),
    });
  }

  async getMemory(agentId: string): Promise<LettaMemory[]> {
    return this.request<LettaMemory[]>(`/v1/agents/${agentId}/memory`);
  }

  async searchMemory(agentId: string, query: string, limit = 5): Promise<LettaMemory[]> {
    return this.request<LettaMemory[]>(`/v1/agents/${agentId}/memory/search`, {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
  }

  isAvailable(): boolean {
    return this.available;
  }

  getStatus(): { available: boolean; consecutiveFailures: number } {
    return {
      available: this.available,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
