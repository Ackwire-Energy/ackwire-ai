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
 * dynamic registration (`register` answers it instead, `registration: false`
 * leaves it out) and a token endpoint that checks PKCE and `resource`.
 */
function oauthServer(
  options: {
    metadata?: boolean;
    tokenHost?: string;
    registration?: boolean;
    register?: (body: { client_name: string }) => Response;
  } = {},
) {
  const seen = { registrations: 0, names: [] as string[], tokenForms: [] as URLSearchParams[], challenge: "" };
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
        ...(options.registration === false ? {} : { registration_endpoint: "https://auth.example.com/register" }),
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.toString() === "https://auth.example.com/register") {
      seen.registrations++;
      const body = JSON.parse(String(init?.body)) as {
        client_name: string;
        redirect_uris: string[];
        token_endpoint_auth_method: string;
      };
      seen.names.push(body.client_name);
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.redirect_uris).toEqual(["https://chat.example.com/api/app/connectors/oauth/callback"]);
      return options.register?.(body) ?? Response.json({ client_id: "dcr-client-1" }, { status: 201 });
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
    // A new server is every agent's, whole: its tools reach them once classified (below).
    expect(
      (await f.db.select().from(schema.agentScopes))
        .filter((g) => g.connectionId === server.id)
        .map((g) => [g.agentId, g.scope]),
    ).toEqual([[f.agent.id, "connector:*"]]);

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
    const write = await gateway.invoke(ctx, {
      toolUseId: "t2",
      name: "suporte_close_ticket",
      input: { id: 1, why: "The checks passed and the change was reviewed: this action finishes what was asked." },
    });
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

  test("connecting the same address again updates the credentials in place: grants and classification stay", async () => {
    f = await setup();
    const mcp = ticketsMcp();
    const deps = depsOf(f, { connect: mcp.connect });
    const first = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "tk_old_12345",
      label: "Tickets",
    });
    if (first.status !== "connected") throw new Error(`expected connected, got ${first.status}`);
    const id = first.server.id;
    await saveCustomTools(deps, f.owner.id, f.org.id, id, {
      label: "Suporte",
      tools: [{ name: "list_tickets", access: "read", label: "Listar chamados" }],
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: id, scope: `custom:${id}:read` }],
      connectorGrantValidator,
    );

    const again = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "tk_new_12345",
      label: "Tickets",
    });
    if (again.status !== "connected") throw new Error(`expected connected, got ${again.status}`);
    expect(again.server.id).toBe(id);
    expect(again.server.label).toBe("Suporte");
    expect(again.server.tools.find((t) => t.name === "list_tickets")?.access).toBe("read");
    expect(await f.db.select().from(schema.connectorConnections)).toHaveLength(1);
    const grants = await f.db.select().from(schema.agentScopes);
    expect(grants.filter((g) => g.connectionId === id).map((g) => g.scope)).toEqual([`custom:${id}:read`]);
    expect(mcp.state.headers.at(-1)).toEqual({ authorization: "Bearer tk_new_12345" });
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
    expect(auth.seen.names).toEqual(["agentes.chat"]);
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

  test("a name it won't take (Calendly: letters, digits, hyphens and spaces) is sent once more without the dot", async () => {
    f = await setup();
    const auth = oauthServer({
      register: (body) =>
        /^[a-z0-9 -]+$/i.test(body.client_name)
          ? Response.json({ client_id: "calendly-client" }, { status: 201 })
          : Response.json(
              {
                error: "invalid_client_metadata",
                errors: { name: ["may only contain alphanumeric characters, hyphens, and spaces."] },
              },
              { status: 400 },
            ),
    });
    const deps = depsOf(f, { connect: ticketsMcp().connect, http: auth.http });
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER });
    if (started.status !== "oauth") throw new Error(`expected oauth, got ${started.status}`);
    expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe("calendly-client");
    expect(auth.seen.names).toEqual(["agentes.chat", "agentes chat"]);
  });

  test("OAuth that only lets in apps it approved says so, not 'no OAuth' (an outage doesn't); a key still connects", async () => {
    f = await setup();
    const mcp = ticketsMcp();
    const refusals = [
      // Asana, Square, Intercom, Mercado Pago, Semrush, Gamma: our redirect URI isn't on their list.
      () =>
        Response.json(
          { error: "invalid_redirect_uri", error_description: "redirect_uri not allowed" },
          { status: 400 },
        ),
      // Dropbox: trusted partners only.
      () =>
        Response.json(
          {
            error: "registration_not_supported",
            error_description: "Only pre-registered MCP trusted partners are allowed.",
          },
          { status: 403 },
        ),
      // RevenueCat.
      () =>
        Response.json({ error: "invalid_client", error_description: "The client is not registered." }, { status: 400 }),
      // Meta Ads.
      () =>
        Response.json(
          {
            error: "invalid_client_metadata",
            error_description: "Dynamic registration is not available for this client.",
          },
          { status: 400 },
        ),
      // Figma.
      () => new Response("Forbidden", { status: 403 }),
    ];
    for (const register of refusals) {
      const auth = oauthServer({ register });
      const deps = depsOf(f, { connect: mcp.connect, http: auth.http });
      expect(await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER })).toEqual({
        status: "needs_key",
        reason: "not_approved",
      });
      // Nothing about the name: asked once.
      expect(auth.seen.names).toEqual(["agentes.chat"]);
    }
    // An outage at registration isn't a refusal: just a key, never "only apps it approved".
    const outages = [
      () => new Response("", { status: 503 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const register of outages) {
      const auth = oauthServer({ register });
      const deps = depsOf(f, { connect: mcp.connect, http: auth.http });
      expect(await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER })).toEqual({
        status: "needs_key",
      });
      expect(auth.seen.names).toEqual(["agentes.chat"]);
    }
    // No registration offered (an app registered with it, as HubSpot asks): not approved either.
    const closed = depsOf(f, { connect: mcp.connect, http: oauthServer({ registration: false }).http });
    expect(await connectCustomServer(closed, f.owner.id, f.org.id, { serverUrl: SERVER })).toEqual({
      status: "needs_key",
      reason: "not_approved",
    });
    const keyed = await connectCustomServer(closed, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "tk_live_12345",
    });
    expect(keyed.status).toBe("connected");
    expect(await f.db.select().from(schema.oauthClients)).toHaveLength(0);
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
