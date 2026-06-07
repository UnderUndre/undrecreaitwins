import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HONCHO_URL = process.env.HONCHO_URL || 'http://localhost:8083';
const HONCHO_API_KEY = process.env.HONCHO_API_KEY || '';

function honchoFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (HONCHO_API_KEY) {
    headers['Authorization'] = `Bearer ${HONCHO_API_KEY}`;
  }
  return fetch(`${HONCHO_URL}/v3${path}`, { ...options, headers });
}

describe('Honcho v3 Contract Test (T008)', () => {
  const tenantId = `test-contract-${Date.now()}`;
  const personaId = 'p-test-persona';
  const sessionId = `session-${Date.now()}`;
  let workspaceId: string;

  it('AC5: creates workspace with tenantId', async () => {
    const res = await honchoFetch(`/workspaces`, {
      method: 'POST',
      body: JSON.stringify({ id: tenantId }),
    });
    expect([200, 201, 409]).toContain(res.status);
    if (res.ok) {
      const data = await res.json();
      workspaceId = data.id || tenantId;
    }
  });

  it('AC5: creates peer within workspace', async () => {
    const peerId = personaId;
    const res = await honchoFetch(`/workspaces/${tenantId}/peers`, {
      method: 'POST',
      body: JSON.stringify({ id: peerId }),
    });
    expect([200, 201, 409]).toContain(res.status);
  });

  it('AC5: creates session', async () => {
    const res = await honchoFetch(`/workspaces/${tenantId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ id: sessionId }),
    });
    expect([200, 201, 409]).toContain(res.status);
  });

  it('AC1: posts message and reads it back (round-trip)', async () => {
    const content = `Contract test fact at ${Date.now()}`;
    const postRes = await honchoFetch(`/workspaces/${tenantId}/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, role: 'user' }),
    });
    expect(postRes.ok).toBe(true);

    const getRes = await honchoFetch(`/workspaces/${tenantId}/sessions/${sessionId}/messages`);
    expect(getRes.ok).toBe(true);
    const messages = await getRes.json();
    const found = Array.isArray(messages)
      ? messages.some((m: any) => m.content === content)
      : false;
    expect(found).toBe(true);
  });

  it('AC5: verifies /v3 prefix is required (non-v3 returns 404)', async () => {
    const res = await fetch(`${HONCHO_URL}/workspaces`);
    expect(res.status).toBe(404);
  });
});

describe('Honcho v3 Permanent Mismatch RED (T008 AC4)', () => {
  it('pointing at legacy/no-v3 endpoint returns permanent classification', async () => {
    const legacyUrl = HONCHO_URL.replace(/\/$/, '');
    const res = await fetch(`${legacyUrl}/apps/test/users/test/sessions`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect([404, 405, 501]).toContain(res.status);
  });
});
