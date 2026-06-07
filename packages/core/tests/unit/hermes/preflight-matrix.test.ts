import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  Object.keys(vars).forEach(key => {
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  });
}

function resetEnv() {
  process.env = { ...originalEnv };
}

describe('Hermes Preflight (T003)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
  });

  it('SC-001: enabled + compatible Hermes → passes, runAgentTurn can spawn', async () => {
    setEnv({
      AGENTIC_EXECUTOR_ENABLED: 'true',
      HERMES_ACP_CMD: 'echo',
    });

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => {
        const emitter = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: Function) => {
            if (event === 'close') {
              cb(0);
            }
          }),
          kill: vi.fn(),
        };
        return emitter;
      }),
    }));

    const { runHermesPreflight } = await import('../../../src/services/hermes/hermes-preflight.js');
    const result = await runHermesPreflight();
    expect(result.ok).toBe(true);
  });

  it('SC-002: enabled + missing → boot fails, unhealthy, typed error, 0 turns', async () => {
    setEnv({
      AGENTIC_EXECUTOR_ENABLED: 'true',
      HERMES_ACP_CMD: 'nonexistent_hermes_binary_xyz',
    });

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => {
        const emitter = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: Function) => {
            if (event === 'error') {
              cb(Object.assign(new Error("spawn nonexistent_hermes_binary_xyz ENOENT"), { code: 'ENOENT' }));
            }
          }),
          kill: vi.fn(),
        };
        return emitter;
      }),
    }));

    const { runHermesPreflight } = await import('../../../src/services/hermes/hermes-preflight.js');
    const result = await runHermesPreflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('hermes_missing');
    }
  });

  it('AC4: disabled + missing → engine starts normally', async () => {
    setEnv({
      AGENTIC_EXECUTOR_ENABLED: 'false',
      HERMES_ACP_CMD: 'nonexistent_binary',
    });

    const { runHermesPreflight } = await import('../../../src/services/hermes/hermes-preflight.js');
    const result = await runHermesPreflight();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.acpProtocolVersion).toBe(0);
    }
  });

  it('AC5: hung hermes acp --check → check_failed within ~5s', async () => {
    setEnv({
      AGENTIC_EXECUTOR_ENABLED: 'true',
      HERMES_ACP_CMD: 'hermes',
    });

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => {
        const emitter = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn(),
        };
        return emitter;
      }),
    }));

    const { runHermesPreflight } = await import('../../../src/services/hermes/hermes-preflight.js');
    const result = await runHermesPreflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('check_failed');
    }
  }, 10000);

  it('AC1: disabled by default (no AGENTIC_EXECUTOR_ENABLED)', async () => {
    setEnv({
      AGENTIC_EXECUTOR_ENABLED: undefined,
      HERMES_ACP_CMD: 'hermes',
    });

    const { runHermesPreflight } = await import('../../../src/services/hermes/hermes-preflight.js');
    const result = await runHermesPreflight();
    expect(result.ok).toBe(true);
  });
});
