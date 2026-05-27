import { describe, it, expect, vi, beforeEach } from 'vitest';
import { personaCommand } from '../../src/commands/persona.js';
import { healthCommand } from '../../src/commands/health.js';
import { getFlag, main } from '../../src/index.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('persona list', () => {
  it('calls GET /v1/personas', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        data: [
          { id: 'p1', name: 'Alice', slug: 'alice', version: 1 },
        ],
      }),
    });

    await personaCommand(
      { apiUrl: 'http://localhost:8090', tenantId: 't1', output: 'json' },
      ['list'],
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8090/v1/personas',
      expect.objectContaining({
        headers: { 'X-Tenant-ID': 't1' },
      }),
    );
  });
});

describe('persona create', () => {
  it('calls POST /v1/personas', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 'p2', name: 'Bob', slug: 'bob' }),
    });

    await personaCommand(
      { apiUrl: 'http://localhost:8090', tenantId: 't1', output: 'json' },
      ['create', 'Bob', 'bob'],
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8090/v1/personas',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Tenant-ID': 't1' }),
      }),
    );

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({
      name: 'Bob',
      slug: 'bob',
      system_prompt: 'You are a helpful assistant.',
    });
  });
});

describe('health', () => {
  it('calls GET /v1/health', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ status: 'ok', version: '1.0.0' }),
    });

    await healthCommand({ apiUrl: 'http://localhost:8090' });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8090/v1/health');
  });

  it('handles unreachable API', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await healthCommand({ apiUrl: 'http://localhost:8090' });

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8090/v1/health');
  });
});

describe('missing tenant-id', () => {
  it('exits with error when tenant-id is missing for non-health command', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      main(['node', 'twin', 'persona', 'list']),
    ).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith('Required: --tenant-id');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('custom API URL', () => {
  it('respects --api-url flag', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ status: 'ok', version: '2.0.0' }),
    });

    await main(['node', 'twin', '--api-url', 'http://custom:9999', 'health']);

    expect(mockFetch).toHaveBeenCalledWith('http://custom:9999/v1/health');
  });

  it('getFlag extracts value correctly', () => {
    const args = ['--api-url', 'http://custom:9999', 'health'];
    expect(getFlag(args, '--api-url')).toBe('http://custom:9999');
    expect(getFlag(args, '--tenant-id')).toBeUndefined();
  });
});
