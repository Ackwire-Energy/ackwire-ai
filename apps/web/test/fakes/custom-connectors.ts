/**
 * Test fake — custom MCP servers ("Conectar outro servidor MCP").
 * Mirrors these endpoints:
 * - GET    /api/app/organizations/{orgId}/connectors/custom
 * - POST   /api/app/organizations/{orgId}/connectors/custom { serverUrl, apiKey?, label?, returnTo }
 *          → { status: "connected", server } | { status: "oauth", authorizeUrl } | { status: "needs_key" }
 * - POST   /api/app/organizations/{orgId}/connectors/custom/{id}/refresh (re-list tools)
 * - PUT    /api/app/organizations/{orgId}/connectors/custom/{id}/tools { label, tools: [{ name, access, label }] }
 * - DELETE /api/app/organizations/{orgId}/connectors/custom/{id}
 * The mock never talks to the URL: it pretends the server offers a ticket
 * tool set, needs an API key unless the URL contains "oauth", and gains one
 * new tool on the first refresh.
 */
import type { ApiClient } from "@/api/client";
import type { CustomServer, CustomTool } from "@/api/types";
import { clone, type MockContext, MockNotFoundError, mockId } from "./context";

const TOOLS: [name: string, description: string, readOnly: boolean | null][] = [
  ["list_tickets", "List support tickets, filtered by status or customer.", true],
  ["get_ticket", "Read one ticket with its messages.", true],
  ["create_ticket", "Open a new ticket for a customer.", false],
  ["close_ticket", "Close a ticket with a resolution note.", null],
  ["delete_customer", "Permanently delete a customer and their data.", false],
];
const LATER: [string, string, boolean | null] = ["export_tickets", "Export tickets as CSV.", true];

const tool = ([name, description, readOnly]: [string, string, boolean | null], now: Date): CustomTool => ({
  name,
  description,
  readOnlyHint: readOnly,
  access: null,
  label: "",
  firstSeenAt: now.toISOString(),
});

export function createMockCustomConnectors(ctx: MockContext): ApiClient["customConnectors"] {
  const byOrg = new Map<string, CustomServer[]>();
  const refreshed = new Set<string>();
  const list = (orgId: string) => {
    let l = byOrg.get(orgId);
    if (!l) {
      l = [];
      byOrg.set(orgId, l);
    }
    return l;
  };
  const find = (orgId: string, id: string) => {
    const s = list(orgId).find((x) => x.id === id);
    if (!s) throw new MockNotFoundError("Server not found");
    return s;
  };
  return {
    list: async (orgId) => clone(list(orgId)),
    connect: async (orgId, input) => {
      const oauth = input.serverUrl.includes("oauth");
      if (!oauth && !input.apiKey) return { status: "needs_key" };
      const now = ctx.now();
      const server: CustomServer = {
        id: mockId("mcp"),
        serverUrl: input.serverUrl,
        label: input.label?.trim() || new URL(input.serverUrl).hostname,
        authType: oauth ? "oauth" : "api_key",
        tools: TOOLS.map((t) => tool(t, now)),
        reviewedAt: null,
        createdAt: now.toISOString(),
      };
      list(orgId).push(server);
      // A real OAuth flow leaves for the provider; the mock connects at once.
      return { status: "connected", server: clone(server) };
    },
    refresh: async (orgId, id) => {
      const s = find(orgId, id);
      if (!refreshed.has(id)) {
        refreshed.add(id);
        s.tools.push(tool(LATER, ctx.now()));
      }
      return clone(s);
    },
    saveTools: async (orgId, id, input) => {
      const s = find(orgId, id);
      s.label = input.label;
      for (const t of input.tools) {
        const existing = s.tools.find((x) => x.name === t.name);
        if (existing) {
          existing.access = t.access;
          existing.label = t.label;
        }
      }
      s.reviewedAt = ctx.now().toISOString();
      return clone(s);
    },
    disconnect: async (orgId, id) => {
      byOrg.set(
        orgId,
        list(orgId).filter((x) => x.id !== id),
      );
    },
  };
}
