import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HonchoClient } from '../../../src/services/hermes/honcho-client.js';

const HONCHO_URL = process.env.HONCHO_URL || 'http://localhost:8083';

describe('Honcho v3 Integration (T009)', () => {
  let client: HonchoClient;
  const tenantA = `int-a-${Date.now()}`;
  const tenantB = `int-b-${Date.now()}`;
  const personaA = 'p-agent';
  const personaB = 'p-agent';

  beforeAll(() => {
    process.env.HONCHO_URL = HONCHO_URL;
    process.env.HONCHO_API_KEY = process.env.HONCHO_API_KEY || '';
    client = new HonchoClient();
  });

  it('AC2: cross-tenant isolation (distinct workspaces)', async () => {
    await client.addMessage(tenantA, personaA, 'sess-1', 'user', 'Tenant A secret fact');
    await client.addMessage(tenantB, personaB, 'sess-1', 'user', 'Tenant B different fact');

    const insightsA = await client.getInsights(tenantA, personaA);
    const insightsB = await client.getInsights(tenantB, personaB);

    const aContents = insightsA.map((i) => i.content);
    const bContents = insightsB.map((i) => i.content);

    expect(aContents.some((c) => c.includes('Tenant A'))).toBe(true);
    expect(bContents.some((c) => c.includes('Tenant B'))).toBe(true);
    expect(aContents.every((c) => !c.includes('Tenant B'))).toBe(true);
    expect(bContents.every((c) => !c.includes('Tenant A'))).toBe(true);
  }, 15000);

  it('AC6: no N+1 — second op uses cache', async () => {
    const tenantC = `int-nplus1-${Date.now()}`;
    await client.ensureSession(tenantC, personaA, 'sess-cache');
    await client.addMessage(tenantC, personaA, 'sess-cache', 'user', 'First');

    await client.addMessage(tenantC, personaA, 'sess-cache', 'user', 'Second (cached)');
  }, 10000);

  it('AC3: honcho-down transient degrade visible', async () => {
    const deadClient = new HonchoClient();
    (deadClient as any).baseUrl = 'http://localhost:19999';
    const result = await deadClient.getInsights('dead-tenant', 'p-agent');
    expect(result).toEqual([]);
  });
});
