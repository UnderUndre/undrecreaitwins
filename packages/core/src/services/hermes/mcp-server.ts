/**
 * Engine MCP server — exposes tool-gateway as an MCP server so a hermes ACP
 * session can call ONLY engine tools. Transport-agnostic handler logic;
 * HTTP binding via Fastify is the primary transport (shares in-process DB).
 * Stdio entrypoint can be added later.
 *
 * NOTE: http-mcp support in "hermes acp" session/new still needs runtime
 * check (stdio is the proven transport from smoke tests, but a stdio engine
 * server cannot share the in-process DB easily — hence http is preferred).
 */
import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import {
  executeTool,
  getToolDefinitions,
  type ToolAllowEntry,
} from './tool-gateway.js';
import { AppError, ForbiddenError } from '@undrecreaitwins/shared';

const logger = pino({ name: 'engine-mcp-server' });

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─── MCP method handler (transport-agnostic) ─────────────────────────────────

export interface McpServerConfig {
  tenantId: string;
  personaId: string;
  /** Persona's tool allow-list entries (from persona.toolAllowlist). */
  allowlist: ToolAllowEntry[];
}

interface AcpMcpServerEntry {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

export class EngineMcpServer {
  private readonly config: McpServerConfig;
  private readonly allowListMap: Map<string, ToolAllowEntry>;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.allowListMap = new Map(config.allowlist.map(e => [e.id, e]));
  }

  /** Handle a single JSON-RPC request and return a JSON-RPC response. */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id = null, method, params = {} } = req;

    try {
      let result: unknown;
      switch (method) {
        case 'initialize':
          result = this.handleInitialize(params);
          break;
        case 'notifications/initialized':
          // notification, no response needed — but caller may still expect one
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          result = this.handleToolsList();
          break;
        case 'tools/call':
          result = await this.handleToolsCall(params);
          break;
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof ForbiddenError ? -32603 :
        err instanceof AppError ? -32603 :
        -32603;
      logger.warn({ err, method }, 'MCP handler error');
      return { jsonrpc: '2.0', id, error: { code, message } };
    }
  }

  // ─── Method handlers ─────────────────────────────────────────────────────

  private handleInitialize(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      protocolVersion: (params.protocolVersion as string) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'engine-tool-gateway', version: '0.1.0' },
    };
  }

  private handleToolsList(): { tools: Array<Record<string, unknown>> } {
    const toolNames = Array.from(this.allowListMap.keys());
    const defs = getToolDefinitions(toolNames);
    const tools: Array<Record<string, unknown>> = defs.map(def => ({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters,
    }));
    return { tools };
  }

  private async handleToolsCall(
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const toolName = params.name as string;
    const args = (params.arguments as Record<string, unknown>) ?? {};

    // 1. Deny if not in allow-list
    const entry = this.allowListMap.get(toolName);
    if (!entry) {
      throw new ForbiddenError(
        `Tool ${toolName} is not in the persona allow-list`,
      );
    }

    // 2. Confirm/dry-run gate — if requiresConfirmation, return preview instead of executing
    if (entry.requiresConfirmation) {
      logger.info({ toolName }, 'Tool requires confirmation — returning dry-run');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'needs_confirmation',
              toolName,
              preview: { args },
              message: `Tool ${toolName} requires explicit confirmation before execution.`,
            }),
          },
        ],
      };
    }

    // 3. Execute via tool-gateway
    const idempotencyKey =
      (params._idempotencyKey as string | undefined) || randomUUID();

    const result = await executeTool({
      tenantId: this.config.tenantId,
      personaId: this.config.personaId,
      toolName,
      args,
      idempotencyKey,
      isWriteAction: entry.isWrite ?? false,
      allowlist: this.config.allowlist,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: result.success,
            result: result.result,
            auditId: result.auditId,
          }),
        },
      ],
    };
  }
}

// ─── HTTP transport (primary — shares in-process DB) ─────────────────────────

export interface HttpMcpServerOptions {
  port: number;
  host?: string;
  config: McpServerConfig;
  /** Shared secret for engine→MCP auth (passed in X-Engine-MCP-Secret header). */
  secret: string;
}

export class HttpMcpTransport {
  private readonly server: EngineMcpServer;
  private readonly fastify: FastifyInstance;
  private readonly secret: string;
  private readonly port: number;
  private readonly host: string;
  private started = false;

  constructor(opts: HttpMcpServerOptions) {
    this.server = new EngineMcpServer(opts.config);
    this.secret = opts.secret;
    this.port = opts.port;
    this.host = opts.host || '127.0.0.1';

    this.fastify = Fastify({
      logger: false, // we use our own pino
      bodyLimit: 1_048_576, // 1MB
    });

    // CORS-like preflight (MCP spec doesn't mandate, but hermes may send it)
    this.fastify.options('/mcp', async (_req, reply) => {
      reply.code(204).send();
    });

    this.fastify.post('/mcp', async (req, reply) => {
      // Auth gate
      const header = req.headers['x-engine-mcp-secret'];
      if (header !== this.secret) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const body = req.body as JsonRpcRequest;
      const response = await this.server.handleRequest(body);
      reply.code(200).header('content-type', 'application/json').send(response);
    });
  }

  /** Start listening. Returns the ACP-compatible mcpServers entry. */
  async start(): Promise<{ mcpEntry: AcpMcpServerEntry; nodeServer: Server }> {
    const address = await this.fastify.listen({ port: this.port, host: this.host });
    this.started = true;
    logger.info({ address }, 'Engine MCP HTTP server listening');

    const mcpEntry: AcpMcpServerEntry = {
      type: 'http',
      url: `${address}/mcp`,
      headers: { 'X-Engine-MCP-Secret': this.secret },
    };

    return { mcpEntry, nodeServer: this.fastify.server };
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.fastify.close();
      this.started = false;
      logger.info('Engine MCP HTTP server stopped');
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a bound MCP server for a given tenant+persona.
 * Use this when you need just the handler (e.g., for stdio or custom transport).
 */
export function makeEngineMcpServer(config: McpServerConfig): EngineMcpServer {
  return new EngineMcpServer(config);
}

/**
 * Build a full HTTP MCP server with transport, ready to .start().
 * Returns the ACP-compatible mcpServers entry for session/new.
 */
export function makeHttpMcpServer(opts: HttpMcpServerOptions): HttpMcpTransport {
  return new HttpMcpTransport(opts);
}
