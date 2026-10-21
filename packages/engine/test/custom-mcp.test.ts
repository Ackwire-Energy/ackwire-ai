import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  type CustomDeps,
  completeOAuth,
  connectCustomServer,
  connectionHeaders,
  connectorGrantValidator,
  createConnectorToolSource,
  createToolGateway,
  type McpConnect,
  mcpSessionOver,
  postPersonMessage,
  refreshCustomServer,
  revokeConnection,
  saveCustomTools,
  setAgentAccess,
  setAgentScopes,
  suggestFor,
  ValidationError,
  wrapExternal,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SERVER = "https://tickets.example.com/mcp";

/** An in-process MCP server with a read-only tool and a write tool; `extra` adds one on demand. */
function ticketsMcp() {
  const state = { extra: false, calls: [] as string[], headers: [] as Record<string, string>[] };
  const build = () => {
    const server = new McpServer({ name: "tickets", version: "1" });
    server.registerTool(
      "list_tickets",
      { description: "List open tickets", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => {
        state.calls.push("list_tickets");
        return { content: [{ type: "text", text: "#1 login broken" }] };
      },
    );
    server.registerTool(
      "close_ticket",
      { description: "Close a ticket", inputSchema: { id: z.number() } },
      async (args) => {
        state.calls.push(`close_ticket ${args.id}`);
        return { content: [{ type: "text", text: `closed #${args.id}` }] };
      },
    );
    if (state.extra) {
      server.registerTool("reopen_ticket", { description: "Reopen", inputSchema: { id: z.number() } }, async () => ({
        content: [{ type: "text", text: "reopened" }],
      }));
    }
    return server;
  };
  const connect: McpConnect = async (_connection, headers) => {
    state.headers.push(headers);
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, state };
}

/**
 * Fake HTTP for MCP-native OAuth: the MCP endpoint answers 401 pointing at its
 * protected-resource metadata; the authorization server has RFC 8414 metadata,
 * dynamic registration and a token endpoint that checks PKCE and `resource`.
 */
function oauthServer(options: { metadata?: boolean; tokenHost?: string } = {}) {
  const seen = { registrations: 0, tokenForms: [] as URLSearchParams[], challenge: "" };
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.toString() === SERVER && method === "POST") {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate":
            options.metadata === false
              ? 'Bearer realm="x"'
              : 'Bearer resource_metadata="https://tickets.example.com/.well-known/oauth-protected-resource/mcp"',
        },
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      if (options.metadata === false) return new Response("nope", { status: 404 });
      return Response.json({
        resource: SERVER,
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["tickets"],
      });
    }
    if (url.toString() === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: `https://${options.tokenHost ?? "auth.example.com"}/token`,
        registration_endpoint: "https://auth.example.com/register",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.toString() === "https://auth.example.com/register") {
      seen.registrations++;
      const body = JSON.parse(String(init?.body)) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.redirect_uris).toEqual(["https://chat.example.com/api/app/connectors/oauth/callback"]);
      return Response.json({ client_id: "dcr-client-1" }, { status: 201 });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      seen.tokenForms.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const ok =
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") === seen.challenge;
        if (!ok || form.get("resource") !== SERVER) return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: `at-${seen.tokenForms.length}`, refresh_token: "rt", expires_in: 30 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { http, seen };
}

const publicDns = async (host: string) => (host.endsWith("example.com") ? ["93.184.216.34"] : ["10.0.0.9"]);

function depsOf(fx: Fixture, extra: Partial<CustomDeps> = {}): CustomDeps {
  return {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: publicDns,
    ...extra,
  };
}

describe("custom MCP servers", () => {
  test("Supabase (read-only): its execute_sql is suggested as read; other tools keep our usual suggestion", async () => {
    expect(suggestFor({ name: "execute_sql" }, ["execute_sql"])).toBe("read");
    // An ambiguous name: the judge decides when listing; by the rules alone, ask first.
    expect(suggestFor({ name: "execute_sql" })).toBe("approval");
    expect(suggestFor({ name: "apply_migration" }, ["execute_sql"])).toBe("write");
    expect(suggestFor({ name: "delete_branch" }, ["execute_sql"])).toBe("approval");
  });

  test("a preset's connection keeps its URL (query and all) and our usual suggestions", async () => {
    f = await setup();
    const mcp = ticketsMcp();
    const deps = depsOf(f, { connect: mcp.connect, resolveHost: async () => ["93.184.216.34"] });
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: "https://mcp.supabase.com/mcp?read_only=true&features=database,docs,debugging",
      apiKey: "sbp_secret_12345",
      label: "Supabase",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    expect(started.server.serverUrl).toBe(
      "https://mcp.supabase.com/mcp?read_only=true&features=database,docs,debugging",
    );
    expect(started.server.tools.map((t) => [t.name, t.suggestedAccess])).toEqual([
      ["close_ticket", "approval"],
      ["list_tickets", "read"],
    ]);
  });

  test("API key: tools come in unclassified and hidden; classified ones reach the agent with our scopes", async () => {
    f = await setup();
    const mcp = ticketsMcp();
    const deps = depsOf(f, { connect: mcp.connect });
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "tk_secret_12345",
      label: "Tickets",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const server = started.server;
    expect(server).toMatchObject({ label: "Tickets", authType: "api_key", reviewedAt: null });
    expect(server.tools.map((t) => [t.name, t.access, t.readOnlyHint])).toEqual([
      ["close_ticket", null, null],
      ["list_tickets", null, true],
    ]);
    expect(JSON.stringify(await f.db.select().from(schema.connectorConnections))).not.toContain("tk_secret_12345");

    const source = createConnectorToolSource({ ...deps, connect: mcp.connect });
    const gateway = createToolGateway({ sources: [source] });
    // Steps and approvals need a real run.
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "x",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
    };
    expect(await source.tools(ctx)).toEqual([]); // nothing classified yet
    // Not even `all` shows unclassified tools.
    const none = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { ...none, all: true });
    expect(await gateway.list(ctx)).toEqual([]);
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, none);

    await saveCustomTools(deps, f.owner.id, f.org.id, server.id, {
      label: "Suporte",
      tools: [
        { name: "list_tickets", access: "read", label: "Listar chamados" },
        { name: "close_ticket", access: "approval", label: "Fechar chamado" },
      ],
    });
    const offered = await source.tools(ctx);
    expect(offered.map((t) => [t.name, t.scope, t.sensitive])).toEqual([
      ["suporte_close_ticket", `custom:${server.id}:write`, true],
      ["suporte_list_tickets", `custom:${server.id}:read`, false],
    ]);
    // The agent sees them only with grants.
    expect(await gateway.list(ctx)).toEqual([]);
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [
        { connectionId: server.id, scope: `custom:${server.id}:read` },
        { connectionId: server.id, scope: `custom:${server.id}:write` },
      ],
      connectorGrantValidator,
    );
    expect((await gateway.list(ctx)).map((t) => t.name).sort()).toEqual([
      "suporte_close_ticket",
      "suporte_list_tickets",
    ]);
    const read = await gateway.invoke(ctx, { toolUseId: "t1", name: "suporte_list_tickets", input: {} });
    expect(read).toMatchObject({
      type: "result",
      output: { content: wrapExternal("suporte_list_tickets", "#1 login broken") },
    });
    const write = await gateway.invoke(ctx, { toolUseId: "t2", name: "suporte_close_ticket", input: { id: 1 } });
    expect(write.type).toBe("approval");
    if (write.type === "approval") expect(write.approval.title).toBe("Suporte: Fechar chamado");
    expect(mcp.state.calls).toEqual(["list_tickets"]);
    expect(mcp.state.headers.at(-1)).toEqual({ authorization: "Bearer tk_secret_12345" });

    // Unknown scopes for this server are refused.
    await expect(
      setAgentScopes(
        f.db,
        f.owner.id,
        f.org.id,
        f.agent.id,
        [{ connectionId: server.id, scope: "custom:other:read" }],
        connectorGrantValidator,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // A new tool on the server comes back unclassified and stays hidden.
    mcp.state.extra = true;
    const refreshed = await refreshCustomServer(deps, f.owner.id, f.org.id, server.id);
    expect(refreshed.tools.find((t) => t.name === "reopen_ticket")?.access).toBeNull();

    // Turned off: never offered, not waiting for review, and the suggestion doesn't turn it back on.
    const off = await saveCustomTools(deps, f.owner.id, f.org.id, server.id, {
      label: "Suporte",
      tools: [{ name: "close_ticket", access: "off", label: "Fechar chamado" }],
    });
    expect(off.tools.find((t) => t.name === "close_ticket")?.access).toBe("off");
    expect((await source.tools(ctx)).map((t) => t.name)).toEqual(["suporte_list_tickets"]);
    const accepted = await acceptCustomSuggestion(deps, f.owner.id, f.org.id, server.id);
    expect(accepted.server.tools.find((t) => t.name === "close_ticket")?.access).toBe("off");
    expect(accepted.server.tools.find((t) => t.name === "reopen_ticket")?.access).not.toBeNull();
  });

  test("MCP-native OAuth: discovery, dynamic registration, PKCE S256 + resource, token refresh", async () => {
    f = await setup();
    const mcp = ticketsMcp();
    const auth = oauthServer();
    const deps = depsOf(f, { connect: mcp.connect, http: auth.http });
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER, returnTo: "/settings" });
    if (started.status !== "oauth") throw new Error(`expected oauth, got ${started.status}`);
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dcr-client-1",
      response_type: "code",
      code_challenge_method: "S256",
      resource: SERVER,
      scope: "tickets",
      redirect_uri: "https://chat.example.com/api/app/connectors/oauth/callback",
    });
    auth.seen.challenge = url.searchParams.get("code_challenge") ?? "";
    const { connection, returnTo } = await completeOAuth(
      deps,
      { id: f.owner.id },
      {
        state: url.searchParams.get("state") ?? "",
        code: "code-1",
      },
    );
    expect(returnTo).toBe("/settings");
    expect(connection.connector.startsWith("custom:")).toBe(true);
    expect(connection.authType).toBe("oauth");
    // The registered client is reused for the next server of the same issuer.
    await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER });
    expect(auth.seen.registrations).toBe(1);
    // The token is about to expire: refreshed at the issuer's token endpoint.
    const headers = await connectionHeaders(deps, connection);
    expect(headers).toEqual({ authorization: "Bearer at-2" });
    expect(auth.seen.tokenForms.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(auth.seen.tokenForms.at(-1)?.get("client_id")).toBe("dcr-client-1");
    // Every connection to that server gone: the server may have dropped the client ("Unrecognized
    // client_id"), so the next connect registers again and replaces the row in place.
    await revokeConnection(f.db, f.owner.id, f.org.id, connection.id);
    await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER });
    expect(auth.seen.registrations).toBe(2);
    expect(await f.db.select().from(schema.oauthClients)).toHaveLength(1);
  });

  test("without OAuth metadata the server needs a key; private addresses are refused", async () => {
    f = await setup();
    const deps = depsOf(f, { connect: ticketsMcp().connect, http: oauthServer({ metadata: false }).http });
    expect(await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER })).toEqual({
      status: "needs_key",
    });
    for (const serverUrl of [
      "http://tickets.example.com/mcp",
      "https://169.254.169.254/mcp",
      "https://intranet.corp/mcp",
    ]) {
      await expect(connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // An authorization server that points its token endpoint inside the network is refused too.
    const sneaky = depsOf(f, { connect: ticketsMcp().connect, http: oauthServer({ tokenHost: "auth.internal" }).http });
    await expect(connectCustomServer(sneaky, f.owner.id, f.org.id, { serverUrl: SERVER })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
