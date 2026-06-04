/**
 * Low-level ACP JSON-RPC/ndjson client.
 * Adapted from the proven acp-smoke.mjs — drives a spawned "hermes acp" process
 * over stdio: initialize → session/new → session/prompt → stream session/update → response.
 *
 * This module owns the process lifecycle and wire protocol. The orchestration
 * (building prompts, mapping updates, fallback) lives in hermes-executor.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AppError } from '@undrecreaitwins/shared';
import pino from 'pino';

const logger = pino({ name: 'acp-adapter' });

// ─── Types ───────────────────────────────────────────────────────────────────

/** Discriminator for session/update notifications. */
export type SessionUpdateKind =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'usage_update';

export interface SessionUpdate {
  kind: SessionUpdateKind;
  /** For agent_message_chunk / agent_thought_chunk: text delta. */
  text?: string;
  /** For tool_call / tool_call_update. */
  toolCallId?: string;
  title?: string;
  rawInput?: string;
  status?: string;
  content?: string;
  /** For usage_update. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Raw params for anything not decomposed above. */
  raw?: unknown;
}

export interface AcpSessionPromptResult {
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AcpMcpServerEntry {
  type: 'http' | 'stdio';
  /** REQUIRED by hermes acp (Pydantic validation) — server name. */
  name: string;
  url?: string;
  /** hermes expects a LIST of {name,value}, NOT an object (verified: http-MCP smoke). */
  headers?: Array<{ name: string; value: string }>;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface AcpClientConfig {
  /** Command to spawn (default from HERMES_ACP_CMD env). */
  command: string;
  /** Arguments (e.g., ['acp', '--accept-hooks']). */
  args: string[];
  /** Working directory for the spawned process. */
  cwd: string;
  /** Model to pass in session/new. */
  model: string;
  /** MCP servers to register in session/new. */
  mcpServers: AcpMcpServerEntry[];
  /** Optional existing sessionId to resume (skip session/new). */
  existingSessionId?: string;
  /** AbortSignal for the whole operation. */
  signal?: AbortSignal;
  /** Callback for each session/update notification. */
  onUpdate?: (update: SessionUpdate) => void;
  /** The full prompt text to send in session/prompt (system + context + user message). */
  promptText: string;
  /** Optional environment variables for the spawned process. */
  extraEnv?: Record<string, string>;
  /** Effective LLM config for BYOK injection (Strategy B). */
  effectiveConfig?: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    temperature?: number | null;
    maxTokens?: number | null;
  };
}

// ─── JSON-RPC framing ────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingEntry = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

// ─── ACP Client ──────────────────────────────────────────────────────────────

export class AcpClient {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingEntry>();
  private buf = '';
  private sessionId: string | null = null;
  private initialized = false;
  private dead = false;

  /** Check if the process is dead. */
  public isDead(): boolean {
    return this.dead;
  }

  /**
   * Run a full ACP turn: spawn → initialize → session/new → session/prompt → collect updates → return.
   * Kills the process when done or on error.
   */
  async runTurn(config: AcpClientConfig): Promise<AcpSessionPromptResult> {
    try {
      await this.spawn(config);
      await this.initialize();
      await this.ensureSession(config);
      const result = await this.prompt(config);
      return result;
    } finally {
      this.kill();
    }
  }

  /**
   * Run session/prompt on an already-spawned+initialized process with the given prompt text.
   * For use when the caller manages spawn/init/session separately.
   */
  async sendPrompt(
    promptText: string,
    onUpdate?: (update: SessionUpdate) => void,
  ): Promise<AcpSessionPromptResult> {
    if (!this.sessionId) {
      throw new AppError('No ACP session', 500, 'acp_no_session');
    }
    this.onUpdateCallback = onUpdate ?? null;
    const result = await this.sendRequest('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: promptText }],
    }) as Record<string, unknown>;

    const stopReason = (result?.stopReason as string) ?? 'unknown';
    const usage = result?.usage as { inputTokens: number; outputTokens: number } | undefined;
    return { stopReason, usage };
  }

  /** Get the sessionId (available after ensureSession). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Kill the process. */
  public kill(): void {
    if (this.child && !this.dead) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
    this.dead = true;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  private async spawn(config: AcpClientConfig): Promise<void> {
    if (this.dead) throw new AppError('ACP client is dead', 500, 'acp_client_dead');

    logger.info({ cmd: config.command, args: config.args, cwd: config.cwd }, 'Spawning hermes acp');

    const env: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...(config.extraEnv || {}),
    } as Record<string, string | undefined>;

    // Strategy B: inject BYOK effective config as env vars for the spawned hermes process
    if (config.effectiveConfig) {
      env.HERMES_PROVIDER = 'custom';
      env.HERMES_BASE_URL = config.effectiveConfig.baseUrl;
      env.HERMES_API_KEY = config.effectiveConfig.apiKey;
      env.HERMES_MODEL_ID = config.effectiveConfig.modelId;
      env.HERMES_TEMPERATURE = String(config.effectiveConfig.temperature ?? '');
      env.HERMES_MAX_TOKENS = String(config.effectiveConfig.maxTokens ?? '');
    }

    this.child = spawn(config.command, config.args, {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      this.drain();
    });

    this.child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        logger.debug({ stderr: text.slice(0, 500) }, 'hermes acp stderr');
      }
    });

    const onAbort = (): void => {
      logger.warn('Abort signal received, killing hermes acp');
      this.kill();
    };

    this.child.on('exit', (code) => {
      logger.info({ code }, 'hermes acp process exited');
      this.dead = true;
      if (config.signal) config.signal.removeEventListener('abort', onAbort);
      const entries = Array.from(this.pending.entries());
      this.pending.clear();
      for (const [, entry] of entries) {
        entry.reject(new AppError(`Process exited with code ${code}`, 502, 'acp_process_exit'));
      }
    });

    this.child.on('error', (err) => {
      logger.error({ err }, 'hermes acp process error');
      this.dead = true;
      if (config.signal) config.signal.removeEventListener('abort', onAbort);
      const entries = Array.from(this.pending.entries());
      this.pending.clear();
      for (const [, entry] of entries) {
        entry.reject(new AppError(`Process error: ${err.message}`, 502, 'acp_process_error'));
      }
    });

    if (config.signal) {
      if (config.signal.aborted) {
        this.kill();
        throw new AppError('Aborted before spawn', 499, 'acp_aborted');
      }
      config.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // ─── JSON-RPC I/O ───────────────────────────────────────────────────────

  private send(msg: JsonRpcMessage): void {
    if (!this.child || this.dead) return;
    const line = JSON.stringify(msg) + '\n';
    this.child.stdin!.write(line);
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      logger.debug({ id, method }, '→ ACP request');
    });
  }

  private sendReply(id: number | string, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private drain(): void {
    while (this.buf.length) {
      // Handle Content-Length framing (LSP-style)
      if (this.buf.startsWith('Content-Length:')) {
        const m = this.buf.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
        if (!m) return; // incomplete header
        const start = m[0].length;
        const len = Number(m[1]);
        if (this.buf.length < start + len) return; // incomplete body
        const body = this.buf.slice(start, start + len);
        this.buf = this.buf.slice(start + len);
        try {
          this.handleMessage(JSON.parse(body));
        } catch (err) {
          logger.warn({ err }, 'Bad LSP-framed body');
        }
      } else {
        const idx = this.buf.indexOf('\n');
        if (idx < 0) return; // incomplete line
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          logger.debug({ line: line.slice(0, 120) }, 'Non-JSON line from hermes acp');
        }
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // 1. Response to our request
    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(Number(msg.id))) {
      const id = Number(msg.id);
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) {
        const err = new AppError(
          msg.error.message || 'ACP error',
          502,
          `acp_${entry.method.replace(/\//g, '_')}`,
        );
        entry.reject(err);
      } else {
        logger.debug({ id, method: entry.method }, '← ACP response');
        entry.resolve(msg.result);
      }
      return;
    }

    // 2. Notification (no id)
    if (msg.id === undefined && msg.method === 'session/update') {
      this.handleSessionUpdate(msg.params as Record<string, unknown>);
      return;
    }

    // 3. Server→client request (has id + method) — must reply
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      logger.debug({ method: msg.method, id: msg.id }, '← ACP server request');
      if (msg.method === 'session/request_permission') {
        // Auto-approve: pick first "allow" option or first option
        const opts = (msg.params as Record<string, unknown>)?.options as Array<Record<string, unknown>> ?? [];
        const allow = opts.find(o => String(o.kind ?? '').startsWith('allow')) ?? opts[0];
        this.sendReply(Number(msg.id), {
          outcome: { outcome: 'selected', optionId: allow?.optionId },
          selectedOptionId: allow?.optionId,
        });
      } else {
        this.sendReply(Number(msg.id), {});
      }
      return;
    }

    logger.debug({ msg }, '← ACP unhandled message');
  }

  // ─── Session/update decomposition ──────────────────────────────────────

  private handleSessionUpdate(params: Record<string, unknown> | undefined): void {
    if (!params) return;

    // The ACP wire format: params.updates is an array of update objects,
    // each with a `sessionUpdate` discriminator (or nested).
    // From smoke: params.update.sessionUpdate or params.updates[].sessionUpdate
    const updates = Array.isArray(params.updates)
      ? params.updates
      : params.update
        ? [params.update]
        : [];

    for (const rawUpd of updates) {
      if (!rawUpd || typeof rawUpd !== 'object') continue;
      const upd = rawUpd as Record<string, unknown>;

      // Extract text content from various shapes
      const textContent = this.extractText(upd);
      const kind = (upd.sessionUpdate ?? upd.kind ?? upd.type ?? '') as string;

      const update: SessionUpdate = {
        kind: kind as SessionUpdateKind,
        raw: upd,
      };

      // Populate fields based on kind
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        update.text = textContent;
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        update.toolCallId = upd.toolCallId as string | undefined;
        update.title = upd.title as string | undefined;
        update.rawInput = upd.rawInput as string | undefined;
        update.status = upd.status as string | undefined;
        update.content = typeof upd.content === 'string' ? upd.content : textContent;
      } else if (kind === 'usage_update') {
        update.usage = upd.usage as SessionUpdate['usage'];
      }

      logger.debug({ kind, text: textContent?.slice(0, 100) }, '· session/update');
      this.onUpdateCallback?.(update);
    }
  }

  private extractText(upd: Record<string, unknown>): string | undefined {
    if (upd.content && typeof upd.content === 'object') {
      const c = upd.content as Record<string, unknown>;
      if (c.type === 'text' && typeof c.text === 'string') return c.text;
    }
    if (typeof upd.text === 'string') return upd.text;
    return undefined;
  }

  private onUpdateCallback: ((update: SessionUpdate) => void) | null = null;

  // ─── High-level ACP methods ──────────────────────────────────────────────

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'engine-acp-adapter', version: '0.1.0' },
    }) as Record<string, unknown>;
    logger.info({ result }, 'ACP initialized');
    this.initialized = true;
  }

  private async ensureSession(config: AcpClientConfig): Promise<void> {
    if (config.existingSessionId) {
      this.sessionId = config.existingSessionId;
      logger.info({ sessionId: this.sessionId }, 'Resuming existing ACP session');
      return;
    }

    const result = await this.sendRequest('session/new', {
      cwd: config.cwd,
      model: config.model,
      mcpServers: config.mcpServers,
    }) as Record<string, unknown>;

    this.sessionId = (result?.sessionId as string) ?? null;
    if (!this.sessionId) {
      throw new AppError('session/new returned no sessionId', 502, 'acp_no_session');
    }
    logger.info({ sessionId: this.sessionId }, 'ACP session created');
  }

  private async prompt(config: AcpClientConfig): Promise<AcpSessionPromptResult> {
    if (!this.sessionId) {
      throw new AppError('No ACP session — call ensureSession first', 500, 'acp_no_session');
    }

    this.onUpdateCallback = config.onUpdate ?? null;

    // Build prompt from user message — the caller should inject system prompt + context
    // into the prompt text via buildPromptText() before calling runTurn.
    const promptText = config.promptText ?? '';
    if (!promptText) {
      throw new AppError('ACP promptText is empty', 400, 'acp_empty_prompt');
    }

    const result = await this.sendRequest('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: promptText }],
    }) as Record<string, unknown>;

    const stopReason = (result?.stopReason as string) ?? 'unknown';
    const usage = result?.usage as { inputTokens: number; outputTokens: number } | undefined;

    return { stopReason, usage };
  }
}
