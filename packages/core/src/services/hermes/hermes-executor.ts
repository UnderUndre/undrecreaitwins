/**
 * HermesExecutor — ACP-backed agent turn orchestration.
 *
 * Drives a spawned "hermes acp" process via the AcpAdapter (JSON-RPC/ndjson/stdio).
 * The agent's tools come from the engine MCP server (mcp-server.ts) which wraps
 * tool-gateway.ts — allowlist, permission, idempotency, audit, confirm/dry-run.
 *
 * Fallback: on timeout, spawn failure, or ACP error → LLMClient.complete (thin completion).
 *
 * Lifecycle/warm-pool (T009) is OUT OF SCOPE — fresh spawn per turn.
 * TODO(T009): process-per-(tenant,persona) pool with isolated HERMES_HOME per tenant.
 */
import type { Persona } from '@undrecreaitwins/shared';
import { AppError } from '@undrecreaitwins/shared';
import { LLMClient } from '../llm-client.js';
import { AcpClient, type SessionUpdate, type AcpMcpServerEntry } from './hermes-adapter.js';
import { makeHttpMcpServer, type McpServerConfig, type HttpMcpTransport } from './mcp-server.js';
import type { ToolAllowEntry } from './tool-gateway.js';
import pino from 'pino';

const logger = pino({ name: 'hermes-executor' });

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
    this.acpCmd = acpCmd;

    // Split into command + args (e.g., "hermes acp --accept-hooks" → cmd="hermes", args=["acp","--accept-hooks"])
    const parts = acpCmd.split(/\s+/);
    this.acpCmd = parts[0]!;
    this.acpArgs = parts.length > 1 ? parts.slice(1) : ['acp', '--accept-hooks'];

    this.fallbackClient = new LLMClient();
  }

  async runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const steps: AgentStepEvent[] = [];
    const controller = new AbortController();

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
    const model = input.persona.modelPreferences?.model ?? 'default';
    const messages = [
      ...input.context.conversationHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: input.userMessage },
    ];

    // Build the full prompt text that ACP receives (system + context injected as first message)
    const promptText = this.buildPromptText(systemPrompt, input.userMessage, input.context);

    // Accumulator for streamed answer
    let answer = '';
    let tokensUsed = 0;
    let toolCallsCount = 0;
    const loopIterations = 0;
    let acpSessionId: string | undefined;

    let mcpServer: { server: { stop: () => Promise<void> }; mcpEntry: { name: string; url: string; headers: Array<{ name: string; value: string }> } } | undefined;

    try {
      // ── Start engine MCP server for this tenant+persona ───────────────
      const allowlist = this.getToolAllowlist(input.persona);
      mcpServer = await this.startMcpServer(input.tenantId, input.persona.id, allowlist);

      // ── ACP turn ──────────────────────────────────────────────────────
      const acpClient = new AcpClient();

      const mcpEntry: AcpMcpServerEntry = {
        type: 'http',
        name: mcpServer.mcpEntry.name,
        url: mcpServer.mcpEntry.url,
        headers: mcpServer.mcpEntry.headers,
      };

      // Session/update → AgentStepEvent callback
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

      const result = await acpClient.runTurn({
        command: this.acpCmd,
        args: this.acpArgs,
        cwd: process.cwd(),
        model,
        mcpServers: [mcpEntry],
        existingSessionId: input.acpSessionId,
        signal: controller.signal,
        onUpdate,
        promptText,
      });

      acpSessionId = acpClient.getSessionId() ?? undefined;

      // Use final usage from response if available
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
    // persona.toolAllowlist may be stored as jsonb on the persona model
    // For now, use a typed accessor — the persona type doesn't include it
    // directly, so we cast through unknown.
    const raw = (persona as unknown as Record<string, unknown>).toolAllowlist;
    if (Array.isArray(raw)) {
      return raw as ToolAllowEntry[];
    }
    // No allowlist → empty (all tools denied)
    return [];
  }

  private buildPromptText(
    systemPrompt: string,
    userMessage: string,
    context: RunAgentTurnInput['context'],
  ): string {
    // ACP session/prompt takes a single text block. We assemble:
    // [system prompt] [context] [few-shot] [user message]
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
    // Persona system prompt ONLY. RAG + few-shot are added once by buildPromptText
    // (ACP path); duplicating them here would inject the context twice.
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
