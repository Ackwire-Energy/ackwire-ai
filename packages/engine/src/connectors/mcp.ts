import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition, ToolSource } from "../tools/types";
import { CONNECTOR_CATALOG, connectorScope, fillTitle } from "./catalog";
import { activeConnections, type ConnectorConnection, type ConnectorDeps, connectionHeaders } from "./connections";

/** A tool as an MCP server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

/** An open MCP client session. Only the connector tool source uses it, behind the Tool Gateway. */
export interface McpSession {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Opens a session to a connection's server. Default: streamable HTTP; tests: in-process. */
export type McpConnect = (connection: ConnectorConnection, headers: Record<string, string>) => Promise<McpSession>;

/** Wraps an official MCP SDK client over any transport. */
export async function mcpSessionOver(transport: Transport): Promise<McpSession> {
  const client = new Client({ name: "agentes.chat", version: "1" });
  await client.connect(transport);
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of res.tools) {
          tools.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      const parts = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`));
      if (parts.length === 0 && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
      return { content: parts.join("\n"), isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

export const connectOverHttp: McpConnect = (connection, headers) =>
  mcpSessionOver(new StreamableHTTPClientTransport(new URL(connection.serverUrl), { requestInit: { headers } }));

/** Name the model sees for a connector tool: `github_merge_pull_request`. */
export const exposedToolName = (connector: string, tool: string) =>
  `${connector}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

const LIST_TTL_MS = 60_000;

/**
 * Tools of the organization's connected MCP servers (layer 2 of D7). Lists
 * each server's tools, keeps only those in our catalog (with our scope and
 * sensitivity), and calls them over MCP. The Tool Gateway filters them by the
 * agent's scopes and gates sensitive ones; this source never decides access.
 * Tool output is untrusted content: it reaches the model only as a tool result.
 */
export function createConnectorToolSource(deps: ConnectorDeps & { connect?: McpConnect }): ToolSource {
  const connect = deps.connect ?? connectOverHttp;
  const cache = new Map<string, { at: number; tools: McpTool[] }>();

  async function withSession<T>(connection: ConnectorConnection, fn: (s: McpSession) => Promise<T>): Promise<T> {
    const session = await connect(connection, await connectionHeaders(deps, connection));
    try {
      return await fn(session);
    } finally {
      await session.close().catch(() => {});
    }
  }

  async function serverTools(connection: ConnectorConnection) {
    const key = `${connection.id}:${connection.updatedAt.getTime()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.tools;
    const tools = await withSession(connection, (s) => s.listTools());
    cache.set(key, { at: Date.now(), tools });
    return tools;
  }

  return {
    name: "connectors",
    async tools(ctx) {
      const out: ToolDefinition[] = [];
      for (const connection of await activeConnections(ctx.db, ctx.orgId)) {
        const def = CONNECTOR_CATALOG[connection.connector];
        if (!def) continue;
        let listed: McpTool[];
        try {
          listed = await serverTools(connection);
        } catch {
          continue; // an unreachable server hides its tools for this turn
        }
        for (const tool of listed) {
          const mapped = def.tools[tool.name];
          if (!mapped) continue; // not in our catalog: never exposed
          out.push({
            name: exposedToolName(def.id, tool.name),
            description: `[${def.label}] ${tool.description ?? tool.name}`.slice(0, 1024),
            inputSchema: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object" },
            scope: connectorScope(def.id, mapped.scope),
            connectionId: connection.id,
            sensitive: mapped.sensitive === true,
            describe: (input) => ({
              title: mapped.title ? fillTitle(mapped.title, input) : `${def.label}: ${tool.name}`,
              detail: `${def.id}.${tool.name} · ${Object.entries(input)
                .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                .join(" · ")}`,
            }),
            execute: async (input) => {
              const result = await withSession(connection, (s) => s.callTool(tool.name, input));
              return {
                content: result.content,
                isError: result.isError,
                data: { connector: def.id, tool: tool.name, isError: result.isError },
              };
            },
          });
        }
      }
      return out;
    },
  };
}
