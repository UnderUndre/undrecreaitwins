/**
 * HermesExecutor — ACP-backed agent turn orchestration.
 *
 * Drives a spawned "hermes acp" process via the AcpAdapter (JSON-RPC/ndjson/stdio).
 * Supports Strategy B: pool keyed by resolved effective config hash.
 *
 * Fallback: on timeout, spawn failure, or ACP error → LLMClient.complete (thin completion).
 */
import type { Persona } from '@undrecreaitwins/shared';
import { AppError } from '@undrecreaitwins/shared';
import { LLMClient } from '../llm-client.js';
import { AcpClient, type SessionUpdate, type AcpMcpServerEntry } from './hermes-adapter.js';
import { makeHttpMcpServer, type McpServerConfig, type HttpMcpTransport } from './mcp-server.js';
import type { ToolAllowEntry } from './tool-gateway.js';
import { db } from '../../db.js';
import { resolveEffectiveConfig } from '../llm-provider/resolution.js';
import { decryptApiKey } from '../llm-provider/crypto.js';
import { createHash } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'hermes-executor' });

// ─── Warm Pool (Strategy B) ──────────────────────────────────────────────────

interface PoolEntry {
  client: AcpClient;
  lastUsedAt: Date;
  configHash: string;
}

/** Global process pool keyed by provider config hash. */
const WARM_POOL = new Map<string, PoolEntry>();
const MAX_POOL_SIZE = parseInt(process.env.LLM_MAX_CONFIGS_PER_TENANT || '8', 10);
const IDLE_TTL_MS = parseInt(process.env.LLM_POOL_IDLE_TTL_MS || '900000', 10);

// ─── Exported interfaces (keep backward-compatible) ──────────────────────────

export interface RunAgentTurnInput {
  tenantId: string;
  persona: Persona;
  sessionId?: string;
  /** ACP session ID for resume (future warm-pool). */
  acpSessionId?: string;
  userMessage: string;
  context: {
    ragChunks?: string[];
    fewShotExamples?: Array<{ input: string; output: string }>;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  budget: {
    maxLoopIterations: number;
    maxTokens: number;
    maxExecutionMs?: number;
  };
}

export interface AgentStepEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'done' | 'budget_exceeded' | 'error' | 'timeout';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
}

export interface RunAgentTurnResult {
  answer: string;
  steps: AgentStepEvent[];
  usage: {
    loopIterations: number;
    tokensUsed: number;
    toolCallsCount: number;
  };
  agentRunId: string;
  fallbackUsed?: boolean;
  /** The ACP session ID — can be passed back for resume. */
  acpSessionId?: string;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class HermesExecutor {
  private readonly acpCmd: string;
  private readonly acpArgs: string[];
  private readonly fallbackClient: LLMClient;

  constructor() {
    const acpCmd = process.env.HERMES_ACP_CMD;
    if (!acpCmd) {
      throw new AppError('HERMES_ACP_CMD is required', 500, 'configuration_error');
    }

    // Split into command + args
    const parts = acpCmd.split(/\s+/);
    this.acpCmd = parts[0]!;
    this.acpArgs = parts.length > 1 ? parts.slice(1) : ['acp', '--accept-hooks'];

    this.fallbackClient = new LLMClient();

    // Start pool GC (reap every minute)
    setInterval(() => this.reapPool(), 60000).unref();
  }

  async runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const steps: AgentStepEvent[] = [];
    const controller = new AbortController();

    // 1. Resolve effective config (Strategy B)
    const effective = await resolveEffectiveConfig(db, input.tenantId, input.persona.id);
    // BYOK injection is materialised by the ACP adapter as a throwaway Hermes profile
    // (HERMES_HOME + config.yaml `model.{provider,base_url,default}` + OPENAI_API_KEY env).
    // We pass the structured effective config — NOT ad-hoc HERMES_* env names, which the
    // Hermes model loader does not read (verified against hermes-agent v0.15.1 source).
    let effectiveConfigForSpawn: { baseUrl: string; apiKey: string; modelId: string; temperature?: number | null; maxTokens?: number | null } | undefined;
    let configHash: string | null = null;
    let model = input.persona.modelPreferences?.model ?? 'default';

    if (effective.source !== 'platform' && effective.config) {
      try {
        const apiKey = await decryptApiKey(effective.config.apiKeyCiphertext, effective.config.apiKeyRef);
        effectiveConfigForSpawn = {
          baseUrl: effective.config.baseUrl,
          apiKey,
          modelId: effective.config.modelId,
          temperature: effective.config.temperature,
          maxTokens: effective.config.maxTokens,
        };
        model = effective.config.modelId;
        configHash = createHash('sha256')
          .update(`${effective.config.baseUrl}|${effective.config.modelId}|${apiKey}`)
          .digest('hex');
      } catch (err) {
        logger.error({ err, tenantId: input.tenantId, personaId: input.persona.id }, 'Failed to resolve/decrypt provider config');
        // Fall back to platform default if decryption fails.
      }
    }

    // ── Hard execution timeout ────────────────────────────────────────────
    const maxMs = input.budget.maxExecutionMs
      ?? (process.env.AGENT_MAX_EXECUTION_MS
        ? parseInt(process.env.AGENT_MAX_EXECUTION_MS, 10)
        : undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (maxMs && Number.isFinite(maxMs) && maxMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, maxMs);
    }

    const systemPrompt = this.buildSystemPrompt(input);
    const messages = [
      ...input.context.conversationHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: input.userMessage },
    ];

    const promptText = this.buildPromptText(systemPrompt, input.userMessage, input.context);

    let answer = '';
    let tokensUsed = 0;
    let toolCallsCount = 0;
    const loopIterations = 0;
    let acpSessionId: string | undefined;

    let mcpServer: { server: { stop: () => Promise<void> }; mcpEntry: { name: string; url: string; headers: Array<{ name: string; value: string }> } } | undefined;

    try {
      // ── Start engine MCP server ───────────────────────────────────────
      const allowlist = this.getToolAllowlist(input.persona);
      mcpServer = await this.startMcpServer(input.tenantId, input.persona.id, allowlist);

      // ── ACP turn (Pooling Logic) ──────────────────────────────────────
      // Definite-assignment: every branch below assigns acpClient before use
      // (pooled hit, pooled miss/evict → new, or no-configHash → new).
      let acpClient!: AcpClient;
      let isPooled = false;

      if (configHash) {
        const entry = WARM_POOL.get(configHash);
        if (entry && !entry.client.isDead()) {
          // T018 — HARD ASSERTION: pooled process must NEVER serve foreign config.
          // This is Strategy B's invariant: pool key == current request's configHash.
          // If this assertion fires, it means a pooled process was indexed under
          // a stale hash — a critical pool coherence violation.
          if (entry.configHash !== configHash) {
            logger.error(
              { poolHash: entry.configHash, requestHash: configHash },
              'POOL COHERENCE VIOLATION — pooled client hash mismatch, evicting',
            );
            WARM_POOL.delete(configHash);
            entry.client.kill();
            // Fall through to create a fresh client below
          } else {
            acpClient = entry.client;
            entry.lastUsedAt = new Date();
            isPooled = true;
            logger.info({ configHash }, 'Using warm-pooled ACP client');
          }
        }

        // Create new client if not pooled (either first time or coherence eviction)
        if (!isPooled) {
          if (WARM_POOL.size >= MAX_POOL_SIZE) {
            this.evictOne();
          }
          acpClient = new AcpClient();
          WARM_POOL.set(configHash, { client: acpClient, lastUsedAt: new Date(), configHash });
          logger.info({ configHash }, 'Created new pooled ACP client');
        }
      } else {
        acpClient = new AcpClient();
      }

      const mcpEntry: AcpMcpServerEntry = {
        type: 'http',
        name: mcpServer.mcpEntry.name,
        url: mcpServer.mcpEntry.url,
        headers: mcpServer.mcpEntry.headers,
      };

      const onUpdate = (update: SessionUpdate): void => {
        switch (update.kind) {
          case 'agent_message_chunk':
            if (update.text) {
              answer += update.text;
              steps.push({ type: 'answer', content: update.text });
            }
            break;
          case 'agent_thought_chunk':
            if (update.text) {
              steps.push({ type: 'thinking', content: update.text });
            }
            break;
          case 'tool_call':
            toolCallsCount++;
            steps.push({
              type: 'tool_call',
              toolName: update.title,
              toolArgs: update.rawInput ? this.safeParseJson(update.rawInput) : undefined,
            });
            break;
          case 'tool_call_update':
            steps.push({
              type: 'tool_result',
              toolName: update.title,
              content: update.content ?? update.status,
            });
            break;
          case 'usage_update':
            if (update.usage?.totalTokens) {
              tokensUsed = update.usage.totalTokens;
            }
            break;
        }
      };

      const result = isPooled
        ? await acpClient.sendPrompt(promptText, onUpdate)
        : await acpClient.runTurn({
            command: this.acpCmd,
            args: this.acpArgs,
            cwd: process.cwd(),
            model,
            mcpServers: [mcpEntry],
            existingSessionId: input.acpSessionId,
            signal: controller.signal,
            onUpdate,
            promptText,
            effectiveConfig: effectiveConfigForSpawn,
          });

      acpSessionId = acpClient.getSessionId() ?? undefined;

      if (result.usage) {
        tokensUsed = result.usage.inputTokens + result.usage.outputTokens;
      }

      steps.push({ type: 'done' });

      return {
        answer,
        steps,
        usage: { loopIterations, tokensUsed, toolCallsCount },
        agentRunId: '',
        acpSessionId,
      };
    } catch (err) {
      if (timedOut) {
        steps.push({ type: 'timeout', content: `Execution timed out after ${maxMs}ms` });
        logger.warn({ maxMs }, 'ACP execution timeout, falling back');
        return this.fallbackComplete(
          messages, systemPrompt, steps, input, model,
          `Execution timeout after ${maxMs}ms`,
        );
      }

      logger.warn({ err }, 'ACP turn failed, falling back to thin completion');
      return this.fallbackComplete(
        messages, systemPrompt, steps, input, model,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (mcpServer) {
        mcpServer.server.stop().catch((stopErr) => {
          logger.error({ err: stopErr }, 'Failed to stop MCP server');
        });
      }
    }
  }

  // ─── Private pool helpers ───────────────────────────────────────────────

  private reapPool(): void {
    const now = Date.now();
    for (const [hash, entry] of WARM_POOL.entries()) {
      if (now - entry.lastUsedAt.getTime() > IDLE_TTL_MS || entry.client.isDead()) {
        logger.info({ hash }, 'Reaping idle or dead pooled ACP client');
        entry.client.kill();
        WARM_POOL.delete(hash);
      }
    }
  }

  private evictOne(): void {
    let oldest: PoolEntry | null = null;
    for (const entry of WARM_POOL.values()) {
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
        oldest = entry;
      }
    }
    if (oldest) {
      logger.info({ hash: oldest.configHash }, 'Evicting LRU pooled ACP client');
      oldest.client.kill();
      WARM_POOL.delete(oldest.configHash);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async startMcpServer(
    tenantId: string,
    personaId: string,
    allowlist: ToolAllowEntry[],
  ): Promise<{ server: HttpMcpTransport; mcpEntry: { name: string; url: string; headers: Array<{ name: string; value: string }> } }> {
    const secret = process.env.ENGINE_MCP_SECRET;
    if (!secret) {
      throw new AppError('ENGINE_MCP_SECRET is required', 500, 'configuration_error');
    }

    const portStr = process.env.ENGINE_MCP_PORT;
    if (!portStr) {
      throw new AppError('ENGINE_MCP_PORT is required', 500, 'configuration_error');
    }
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port) || port <= 0) {
      throw new AppError('ENGINE_MCP_PORT must be a positive integer', 500, 'configuration_error');
    }

    const config: McpServerConfig = { tenantId, personaId, allowlist };
    const transport = makeHttpMcpServer({ port, config, secret });
    const { mcpEntry } = await transport.start();
    return { server: transport, mcpEntry };
  }

  private getToolAllowlist(persona: Persona): ToolAllowEntry[] {
    const raw = (persona as unknown as Record<string, unknown>).toolAllowlist;
    if (Array.isArray(raw)) {
      return raw as ToolAllowEntry[];
    }
    return [];
  }

  private buildPromptText(
    systemPrompt: string,
    userMessage: string,
    context: RunAgentTurnInput['context'],
  ): string {
    const parts: string[] = [];
    parts.push(systemPrompt);
    if (context.ragChunks?.length) {
      parts.push('\n---\nRelevant context:\n' + context.ragChunks.join('\n'));
    }
    if (context.fewShotExamples?.length) {
      parts.push('\n---\nExamples:');
      for (const ex of context.fewShotExamples) {
        parts.push(`User: ${ex.input}\nAssistant: ${ex.output}`);
      }
    }
    parts.push(`\n---\nUser: ${userMessage}`);
    return parts.join('\n');
  }

  private buildSystemPrompt(input: RunAgentTurnInput): string {
    return input.persona.systemPrompt || `You are ${input.persona.name}, an AI assistant.`;
  }

  private safeParseJson(text: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private async fallbackComplete(
    messages: Array<{ role: string; content: string }>,
    systemPrompt: string,
    steps: AgentStepEvent[],
    input: RunAgentTurnInput,
    model: string,
    _fallbackReason: string,
  ): Promise<RunAgentTurnResult> {
    const llmMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages,
    ];

    const llmResponse = await this.fallbackClient.complete({
      messages: llmMessages,
      model,
      maxTokens: input.budget.maxTokens,
      tenantId: input.tenantId,
      personaId: input.persona.id,
    });

    steps.push({ type: 'answer', content: llmResponse.content });
    steps.push({ type: 'done' });

    return {
      answer: llmResponse.content,
      steps,
      usage: {
        loopIterations: 0,
        tokensUsed: llmResponse.usage.total_tokens,
        toolCallsCount: 0,
      },
      agentRunId: '',
      fallbackUsed: true,
    };
  }
}
