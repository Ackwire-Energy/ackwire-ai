import { type ComposioClient, composioFile, FileTooLargeError, type PubSub } from "@agenteschat/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ARTIFACT_LIMITS, type ArtifactDeps, createFileArtifact } from "../artifacts";
import { recordAudit } from "../audit";
import { connectorKeyOf } from "../connector-usage";
import { cutText } from "../format";
import { assertPublicHttpsUrl, type ResolveHost } from "../net-guard";
import { replyThreadOf } from "../runs";
import { alwaysAsks, MAX_RESULT_CHARS } from "../tools/gateway";
import type { ToolContext, ToolDefinition, ToolSource } from "../tools/types";
import { CONNECTOR_CATALOG, connectorScope, fillTitle } from "./catalog";
import { composioFailure, composioServiceOf } from "./composio";
import {
  activeConnections,
  type ConnectorConnection,
  type ConnectorDeps,
  connectionHeaders,
  toolPrefixOfConnection,
} from "./connections";
import {
  COMPOSIO_ANY_ACTION,
  COMPOSIO_EXECUTOR,
  classifiedTools,
  composioActions,
  customScope,
  isCustom,
  type ToolAccess,
} from "./custom";
import { applyToolPins } from "./pins";
import { composioAction, presetForServer } from "./presets";
import type { McpServerInfo } from "./server-icon";

/** A tool as an MCP server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** The server's `readOnlyHint` annotation, when it sends one. */
  readOnlyHint?: boolean | null;
  /** The server's `destructiveHint` annotation, when it sends one. */
  destructiveHint?: boolean | null;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
  /** A Composio action's answer as Composio gave it (files and all), for `keepComposioFiles`. */
  data?: unknown;
}

/** An open MCP client session. Only the connector tool source uses it, behind the Tool Gateway. */
export interface McpSession {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Who the server said it is in `initialize` (name, title, icons); null when it said nothing. */
  serverInfo?(): McpServerInfo | null;
  close(): Promise<void>;
}

/**
 * Opens a session to a connection's server (or one not stored yet). Default: streamable HTTP; tests: in-process. A
 * service through Composio is opened by its workspace and Composio account (`withComposio`).
 */
export type McpConnect = (
  connection: Pick<ConnectorConnection, "serverUrl"> &
    Partial<Pick<ConnectorConnection, "orgId" | "composioAccountId">>,
  headers: Record<string, string>,
) => Promise<McpSession>;

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
            readOnlyHint: (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint ?? null,
            destructiveHint: (t.annotations as { destructiveHint?: boolean } | undefined)?.destructiveHint ?? null,
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
    serverInfo: () => (client.getServerVersion() as McpServerInfo | undefined) ?? null,
    close: () => client.close(),
  };
}

export const connectOverHttp: McpConnect = (connection, headers) =>
  mcpSessionOver(new StreamableHTTPClientTransport(new URL(connection.serverUrl), { requestInit: { headers } }));

/** Name the model sees for a connector tool: `github_merge_pull_request`. */
export const exposedToolName = (connector: string, tool: string) =>
  `${connector}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

const LIST_TTL_MS = 60_000;

/** Read before Composio's own words in its executor's description: what asks a person and what doesn't. */
const EXECUTOR_NOTE =
  "Reads such as list, get and search run without asking a person. GraphQL and SQL actions ask every time. Keep sync_response_to_workbench false unless you must script over the output: the workbench and bash ask a person every time.";

/**
 * Tools of the organization's connected MCP servers (layer 2 of ADR 0016). Lists
 * each server's tools, keeps only those in our catalog (with our scope and
 * sensitivity), and calls them over MCP. The Tool Gateway filters them by the
 * agent's scopes and gates sensitive ones; this source never decides access.
 * Tool output is untrusted content: it reaches the model only as a tool result.
 */
export function createConnectorToolSource(
  deps: ConnectorDeps & {
    connect?: McpConnect;
    /** Where files a Composio action returns are kept (the workspace's Drive); none: they aren't kept. */
    artifacts?: ArtifactDeps;
    log?: { warn(message: string, data?: Record<string, unknown>): void };
    /** Tells connector admins live when a server changes an approved tool. */
    pubsub?: PubSub;
  },
): ToolSource {
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
    const listed = await withSession(connection, (s) => s.listTools());
    const tools = await applyToolPins(deps, connection, listed, pinnedTool(connection));
    cache.set(key, { at: Date.now(), tools });
    return tools;
  }

  /** Which of a connection's tools keep their approved text (ADR 0117): not Composio's (pinned by toolkit version), not ours. */
  function pinnedTool(connection: ConnectorConnection): (name: string) => boolean {
    if (isCustom(connection)) return composioServiceOf(connection.serverUrl) ? () => false : () => true;
    const def = CONNECTOR_CATALOG[connection.connector];
    return (name) => Boolean(def?.tools[name] && !def.tools[name]?.ours);
  }

  /**
   * A custom server's tools that an admin classified (hidden until then; `off`
   * never shows). `approval` and sensitive tools ask a person for every call;
   * `write` tools run on their own and each call goes to the audit log.
   * Composio's executor says which actions each call runs: reads go as the
   * server's reads, and "Aprovar sempre" may cover its other actions (no other
   * tool's); its workbench, bash and proxy always ask.
   */
  async function customToolsOf(connection: ConnectorConnection): Promise<ToolDefinition[]> {
    // A Composio account that stopped working has no tools until it is reconnected.
    if (connection.status === "needs_reconnect") return [];
    const classified = await classifiedTools(deps.db, connection.id);
    if (classified.length === 0) return [];
    let listed: McpTool[];
    try {
      listed = await serverTools(connection);
    } catch {
      return [];
    }
    const byName = new Map(listed.map((t) => [t.name, t]));
    const preset = presetForServer(connection.serverUrl)?.id;
    const composio = composioServiceOf(connection.serverUrl);
    const prefix = toolPrefixOfConnection(connection);
    return classified.flatMap((row): ToolDefinition[] => {
      const tool = byName.get(row.name);
      const access = row.access as ToolAccess;
      if (!tool) return [];
      const executor = tool.name === COMPOSIO_EXECUTOR;
      const action = composio ? composioAction(composio.way, tool.name) : null;
      // Our rules for a Composio action as they are now (its entry's `ask`, its tags at the pinned version), not only
      // as the row stored them at the last sync: an action they make ask asks on every connection at once.
      const asks = composio !== null && tool.destructiveHint === true;
      const said = executor
        ? [EXECUTOR_NOTE, tool.description].filter(Boolean).join(" ")
        : (tool.description ?? tool.name);
      return [
        {
          name: exposedToolName(prefix, tool.name),
          description: cutText(`[${connection.label}] ${row.label}: ${said}`, 1024),
          inputSchema: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object" },
          scope: customScope(connection.id, access),
          connectionId: connection.id,
          // Through Composio, counted under the toolkit's alias as ADR 0103 §7 says.
          connector: composio
            ? { key: connectorKeyOf({ toolkit: composio.way.toolkit }), via: "composio", tool: tool.name }
            : { key: connectorKeyOf(connection), via: "mcp", tool: tool.name },
          connectorLabel: connection.label,
          service: preset,
          serviceIcon: connection.icon ?? undefined,
          toolPrefix: prefix,
          // A sensitive tool never runs without approval, whatever is stored.
          sensitive: access === "approval" || row.sensitive || asks || COMPOSIO_ANY_ACTION.has(tool.name),
          // Its exact call may be approved ahead, except a tool that runs whatever its input says.
          ahead: !COMPOSIO_ANY_ACTION.has(tool.name),
          external: true, // whatever the server returns is third-party text
          // Only the executor names what each call does; any other tool approved for good would run with any params.
          // A Composio action is one action: approved for good when it asks only because of its level.
          ...(executor
            ? { actions: composioActions, readScope: customScope(connection.id, "read"), rememberAs: tool.name }
            : action && !row.sensitive && !asks && !alwaysAsks(action)
              ? { rememberAs: tool.name }
              : {}),
          describe: (input) => {
            const actions = executor ? composioActions(input) : null;
            return {
              title: `${connection.label}: ${actions ? actions.join(", ") : row.label}`,
              detail: `${tool.name} · ${Object.entries(input)
                .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                .join(" · ")}`,
            };
          },
          execute: async (input, ctx) => {
            let result: McpCallResult;
            try {
              result = await withSession(connection, (s) => s.callTool(tool.name, input));
            } catch (error) {
              if (!composio) throw error;
              return composioFailure(deps, connection, error);
            }
            if (composio && deps.composio && !result.isError) {
              const kept = await keepComposioFiles(
                { client: deps.composio.client, artifacts: deps.artifacts, resolveHost: deps.resolveHost },
                ctx,
                result,
                connection.label,
              );
              result = { ...result, content: kept };
            }
            if (access === "write" && !row.sensitive) {
              await recordAudit(ctx.db, {
                orgId: ctx.orgId,
                actor: { type: "agent", id: ctx.agentId },
                action: "connector.tool_changed",
                target: { type: "connector_connection", id: connection.id },
                details: { tool: tool.name, runId: ctx.runId, isError: result.isError },
              }).catch(() => {});
            }
            return {
              content: result.content,
              isError: result.isError,
              data: { connector: "custom", serverId: connection.id, tool: tool.name, isError: result.isError },
            };
          },
        },
      ];
    });
  }

  return {
    name: "connectors",
    async tools(ctx) {
      const out: ToolDefinition[] = [];
      for (const connection of await activeConnections(ctx.db, ctx.orgId)) {
        if (isCustom(connection)) {
          out.push(...(await customToolsOf(connection)));
          continue;
        }
        const def = CONNECTOR_CATALOG[connection.connector];
        if (!def) continue;
        const prefix = toolPrefixOfConnection(connection);
        let listed: McpTool[];
        try {
          listed = await serverTools(connection);
        } catch {
          continue; // an unreachable server hides its tools for this turn
        }
        for (const tool of listed) {
          const mapped = def.tools[tool.name];
          if (!mapped || mapped.ours) continue; // not in our catalog, or one we serve: never exposed
          out.push({
            name: exposedToolName(prefix, tool.name),
            description: cutText(`[${connection.label}] ${tool.description ?? tool.name}`, 1024),
            inputSchema: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object" },
            scope: connectorScope(def.id, mapped.scope),
            connectionId: connection.id,
            connector: { key: def.id, via: "mcp", tool: tool.name },
            connectorLabel: connection.label,
            service: def.id,
            toolPrefix: prefix,
            sensitive: mapped.sensitive === true,
            ahead: true,
            external: true, // whatever the server returns is third-party text
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
                ...(mapped.onSuccess && !result.isError
                  ? {
                      outcome: {
                        kind: mapped.onSuccess.kind,
                        subject: fillTitle(mapped.onSuccess.subject, input),
                        summary: `${def.label} ${tool.name}`,
                      },
                    }
                  : {}),
              };
            },
          });
        }
      }
      return out;
    },
  };
}

/** What marks a file in a Composio answer: a short-lived download link, or the file's bytes inline. */
const FILE_LINK = ["s3url", "s3_url"];
const FILE_BYTES = ["contentBytes", "content_bytes", "base64"];
const TEXT_TYPE = /^(text\/|application\/(json|xml|csv|x-ndjson|yaml)|.*\+(json|xml)$)/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFile = (v: Record<string, unknown>) =>
  FILE_LINK.some((k) => typeof v[k] === "string") ||
  (FILE_BYTES.some((k) => typeof v[k] === "string") && ["mimetype", "mimeType", "name"].some((k) => k in v));

/**
 * Files in a Composio answer, downloaded now: the link expires, and it never reaches the model. A text file that fits
 * the result comes back as text; anything else is kept in the workspace's Drive as untrusted content, and the answer
 * names the file. Returns the answer to show, as JSON.
 */
export async function keepComposioFiles(
  deps: { client: Pick<ComposioClient, "fetchFile">; artifacts?: ArtifactDeps; resolveHost?: ResolveHost },
  ctx: ToolContext,
  result: McpCallResult,
  from: string,
): Promise<string> {
  const { artifacts } = deps;
  // The answer carries the service's data too, and composioFile follows links under several keys (a nested `file`,
  // `response_data`, `url`…): each is checked as it is fetched, so none reaches our own network. Nothing past what the
  // Drive keeps is read, so a huge file can't fill the server's memory.
  const client: Pick<ComposioClient, "fetchFile"> = {
    fetchFile: async (url) => {
      await assertPublicHttpsUrl(url, deps.resolveHost);
      return deps.client.fetchFile(url, ARTIFACT_LIMITS.fileBytes);
    },
  };
  const keep = async (file: Record<string, unknown>) => {
    const named = ["name", "file_name", "fileName", "filename"].map((k) => file[k]).find((v) => typeof v === "string");
    const name = typeof named === "string" && named.trim() ? named.trim().slice(0, 200) : "file";
    let bytes: { data: Uint8Array; contentType?: string };
    try {
      bytes = await composioFile(client, file);
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        return { file: name, error: `The file is over ${error.maxBytes / 1024 / 1024} MB, too large to keep.` };
      }
      return { file: name, error: "The file couldn't be downloaded. Try again." };
    }
    const type = bytes.contentType ?? "";
    if (TEXT_TYPE.test(type) || /\.(txt|md|csv|json|xml|ya?ml|html?)$/i.test(name)) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.data);
      if (text.length <= MAX_RESULT_CHARS / 2 && !text.includes("\uFFFD")) return { file: name, text };
    }
    if (!artifacts) return { file: name, error: "Files can't be kept on this server." };
    try {
      const saved = await createFileArtifact(
        { ...artifacts, db: ctx.db },
        {
          type: "agent",
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          threadId: replyThreadOf(ctx),
          runId: ctx.runId,
        },
        ctx.orgId,
        { title: name, name, bytes: bytes.data, contentType: type || null, note: `From ${from}` },
      );
      return { file: name, savedAs: `file ${saved.id} in the Drive (untrusted content)` };
    } catch (error) {
      return { file: name, error: `The file couldn't be kept: ${error instanceof Error ? error.message : "failed"}` };
    }
  };
  // Past this depth nothing is shown: a link down there would otherwise reach the model.
  const walk = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 12) return "…";
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await walk(item, depth + 1));
      return out;
    }
    if (!isRecord(value)) return value;
    if (isFile(value)) return keep(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await walk(item, depth + 1);
    return out;
  };
  return JSON.stringify(await walk(result.data ?? {}, 0));
}
