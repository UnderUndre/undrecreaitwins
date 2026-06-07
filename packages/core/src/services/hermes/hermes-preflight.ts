import { parseAcpCommand, type AcpCommandResult } from './acp-command.js';
import { spawn } from 'node:child_process';
import pino from 'pino';

const logger = pino({ name: 'hermes-preflight' });

const PREFLIGHT_TIMEOUT_MS = 5000;

export type PreflightError = 'hermes_missing' | 'acp_incompatible' | 'check_failed';

export interface PreflightOk {
  ok: true;
  resolvedCommand: string;
  acpProtocolVersion: number;
}

export interface PreflightFail {
  ok: false;
  error: { code: PreflightError; message: string };
}

export type PreflightResult = PreflightOk | PreflightFail;

export async function runHermesPreflight(): Promise<PreflightResult> {
  const enabled = process.env.AGENTIC_EXECUTOR_ENABLED === 'true';
  if (!enabled) {
    logger.info('AGENTIC_EXECUTOR_ENABLED !== true — skipping Hermes preflight');
    return { ok: true, resolvedCommand: '', acpProtocolVersion: 0 };
  }

  const raw = process.env.HERMES_ACP_CMD;
  if (!raw) {
    return {
      ok: false,
      error: {
        code: 'hermes_missing',
        message: 'HERMES_ACP_CMD is not set (required when AGENTIC_EXECUTOR_ENABLED=true)',
      },
    };
  }

  const parsed: AcpCommandResult = parseAcpCommand(raw);
  const checkArgs = [...parsed.args, '--check'];

  try {
    const result = await spawnWithTimeout(parsed.cmd, checkArgs, PREFLIGHT_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: 'check_failed',
          message: `Hermes preflight failed: '${parsed.cmd} ${checkArgs.join(' ')}' exited ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`,
        },
      };
    }

    const version = parseProtocolVersion(result.stdout);
    if (version === null) {
      return {
        ok: false,
        error: {
          code: 'acp_incompatible',
          message: `Hermes preflight: could not parse ACP protocolVersion from '${parsed.cmd} ${checkArgs.join(' ')}'. stdout: ${result.stdout.slice(0, 500)}`,
        },
      };
    }
    if (version !== 1) {
      return {
        ok: false,
        error: {
          code: 'acp_incompatible',
          message: `Hermes preflight: ACP protocolVersion ${version} is not compatible (expected 1)`,
        },
      };
    }

    logger.info({ resolvedCommand: parsed.cmd, protocolVersion: version }, 'Hermes preflight passed');
    return { ok: true, resolvedCommand: parsed.cmd, acpProtocolVersion: version };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as any).code : undefined;
    if (code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'hermes_missing',
          message: `Hermes preflight failed: '${parsed.cmd}' not found on PATH (HERMES_ACP_CMD='${raw}')`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'check_failed',
        message: `Hermes preflight failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function spawnWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Hermes preflight timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr });
      }
    });
  });
}

function parseProtocolVersion(output: string): number | null {
  try {
    const data = JSON.parse(output);
    if (typeof data?.protocolVersion === 'number') return data.protocolVersion;
  } catch {}
  const match = output.match(/protocolVersion[=:]\s*"?(\d+)"?/i);
  if (match) return parseInt(match[1]!, 10);
  return null;
}
