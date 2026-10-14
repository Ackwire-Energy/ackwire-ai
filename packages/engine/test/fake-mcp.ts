import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpConnect, mcpSessionOver } from "../src";

/**
 * An in-process MCP server shaped like GitHub's (no network). Records every
 * call and the auth headers each session was opened with.
 */
export function fakeGithubMcp() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const sessions: { serverUrl: string; headers: Record<string, string> }[] = [];
  const pr = { owner: z.string(), repo: z.string(), pullNumber: z.number().int() };

  const build = () => {
    const server = new McpServer({ name: "fake-github", version: "1" });
    server.registerTool("get_pull_request", { description: "Get a pull request", inputSchema: pr }, async (args) => {
      calls.push({ tool: "get_pull_request", args });
      return { content: [{ type: "text", text: `PR #${args.pullNumber}: fix token refresh (checks passing)` }] };
    });
    server.registerTool(
      "merge_pull_request",
      { description: "Merge a pull request", inputSchema: { ...pr, merge_method: z.string().optional() } },
      async (args) => {
        calls.push({ tool: "merge_pull_request", args });
        return { content: [{ type: "text", text: `Merged PR #${args.pullNumber}` }] };
      },
    );
    // Not in our catalog: must never reach an agent.
    server.registerTool(
      "delete_repository",
      { description: "Delete a repository", inputSchema: { repo: z.string() } },
      async (args) => {
        calls.push({ tool: "delete_repository", args });
        return { content: [{ type: "text", text: "deleted" }] };
      },
    );
    server.registerTool(
      "get_issue",
      { description: "Get an issue", inputSchema: { number: z.number() } },
      async () => ({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      }),
    );
    return server;
  };

  const connect: McpConnect = async (connection, headers) => {
    sessions.push({ serverUrl: connection.serverUrl, headers });
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, calls, sessions };
}
