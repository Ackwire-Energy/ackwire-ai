import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { McpConnect } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("connectors API: catalog, API-key connection (masked), agent scopes, OAuth start and callback", async () => {
  let challenge = "";
  const http = (async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    const ok =
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url") === challenge;
    return ok
      ? Response.json({ access_token: "gho_live", expires_in: 3600 })
      : Response.json({ error: "bad" }, { status: 400 });
  }) as unknown as typeof fetch;
  t = await createTestServer({
    http,
    env: { CONNECTOR_GITHUB_CLIENT_ID: "gh-id", CONNECTOR_GITHUB_CLIENT_SECRET: "gh-secret" },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);

  const catalog = (await (await owner("/api/app/connectors/catalog")).json()) as {
    connectors: { id: string; oauthConfigured: boolean; scopes: { id: string; sensitive: boolean }[] }[];
    builtinScopes: { id: string }[];
  };
  const github = catalog.connectors.find((c) => c.id === "github");
  expect(github?.oauthConfigured).toBe(true);
  expect(github?.scopes.find((s) => s.id === "github:pr.merge")?.sensitive).toBe(true);
  // No Linear OAuth app here: Linear is the one-click MCP server.
  expect(catalog.connectors.find((c) => c.id === "linear")).toMatchObject({ kind: "remote_mcp" });
  expect(catalog.builtinScopes.map((s) => s.id)).toContain("context:read");

  const created = await owner(`/api/app/organizations/${orgId}/connectors`, {
    json: { connector: "sentry", apiKey: "sntrys_secret_value" },
  });
  expect(created.status).toBe(201);
  const sentry = (await created.json()) as { id: string };
  const listed = await (await owner(`/api/app/organizations/${orgId}/connectors`)).text();
  expect(listed).toContain(sentry.id);
  expect(listed).not.toContain("sntrys_secret_value");

  const put = await owner(`/api/app/organizations/${orgId}/agents/${agentId}/scopes`, {
    method: "PUT",
    json: {
      scopes: [
        { connectionId: sentry.id, scope: "sentry:issues.read" },
        { connectionId: null, scope: "context:read" },
      ],
    },
  });
  expect(put.status).toBe(200);
  expect(
    (
      await owner(`/api/app/organizations/${orgId}/agents/${agentId}/scopes`, {
        method: "PUT",
        json: { scopes: [{ connectionId: sentry.id, scope: "github:pr.merge" }] },
      })
    ).status,
  ).toBe(400);

  const start = (await (
    await owner(`/api/app/organizations/${orgId}/connectors/github/oauth/start`, { json: { returnTo: "/settings" } })
  ).json()) as { authorizeUrl: string };
  const url = new URL(start.authorizeUrl);
  challenge = url.searchParams.get("code_challenge") ?? "";
  const back = await owner(`/api/app/connectors/oauth/callback?state=${url.searchParams.get("state")}&code=abc`);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("http://localhost:3000/settings?connected=github");
  const conns = (await (await owner(`/api/app/organizations/${orgId}/connectors`)).json()) as {
    connections: { connector: string; authType: string }[];
  };
  expect(conns.connections.map((c) => [c.connector, c.authType]).sort()).toEqual([
    ["github", "oauth"],
    ["sentry", "api_key"],
  ]);
  // Replaying the callback fails and says so in the redirect.
  const replay = await owner(`/api/app/connectors/oauth/callback?state=${url.searchParams.get("state")}&code=abc`);
  expect(replay.headers.get("location")).toContain("connector_error=");
});

type Listed = {
  id: string;
  kind: string;
  category: string;
  serverUrl: string | null;
  available: boolean;
  iconUrl: string | null;
  brandColor: string | null;
};

test("catalog: one list of our connectors and the one-click MCP servers, one entry per service, brand icons", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as { connectors: Listed[] };
  const ids = connectors.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  const byId = (id: string) => connectors.find((c) => c.id === id);
  expect(byId("notion")).toMatchObject({
    kind: "remote_mcp",
    category: "docs",
    serverUrl: "https://mcp.notion.com/mcp",
    available: true,
    iconUrl: "/connectors/notion.svg",
    brandColor: null,
  });
  expect(byId("zapier")).toMatchObject({ category: "automation", brandColor: "#FF4F00" });
  expect(byId("stripe")?.category).toBe("payments");
  // Linear and Sentry are in both lists: without an OAuth app here, the one-click server wins.
  expect(byId("linear")).toMatchObject({ kind: "remote_mcp", serverUrl: "https://mcp.linear.app/mcp" });
  expect(byId("sentry")?.kind).toBe("remote_mcp");
  // Ours: GitHub (API key at least) and Drive (asks for the server address).
  expect(byId("github")).toMatchObject({ kind: "catalog", category: "dev", available: true });
  expect(byId("drive")).toMatchObject({ kind: "catalog", iconUrl: "/connectors/googledrive.svg" });
  // No icon in Simple Icons: a monogram.
  expect(byId("canva")?.iconUrl).toBeNull();
  // Every icon the catalog names exists in the web app.
  const publicDir = new URL("../../web/public", import.meta.url).pathname;
  for (const c of connectors) {
    if (c.iconUrl) expect(existsSync(`${publicDir}${c.iconUrl}`)).toBe(true);
  }
});

test("catalog: with its OAuth app configured, our Linear connector replaces the one-click server", async () => {
  t = await createTestServer({
    env: { CONNECTOR_LINEAR_CLIENT_ID: "lin-id", CONNECTOR_LINEAR_CLIENT_SECRET: "lin-secret" },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as { connectors: Listed[] };
  const linear = connectors.filter((c) => c.id === "linear");
  expect(linear).toHaveLength(1);
  expect(linear[0]).toMatchObject({ kind: "catalog", category: "product", iconUrl: "/connectors/linear.svg" });
});

test("connector tools API: classified on listing (judge for ambiguous names), sensitive ones can't be freed", async () => {
  const tools = [
    { name: "campaign_list", inputSchema: { type: "object" } },
    { name: "campaign_delete", inputSchema: { type: "object" } },
    { name: "pixel_track", description: "Send a web event to a pixel.", inputSchema: { type: "object" } },
  ];
  const mcpConnect: McpConnect = async () => ({
    listTools: async () => tools,
    callTool: async () => ({ content: "ok", isError: false }),
    close: async () => {},
  });
  t = await createTestServer({
    mcpConnect,
    resolveHost: async () => ["93.184.216.34"],
    judge: (kind, id) =>
      kind === "connector_tool_level" ? (id.startsWith("level_") ? "write" : "changes_undoable") : undefined,
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${orgId}/connectors/custom`, {
    json: { serverUrl: "https://ads.example.com/mcp", apiKey: "ads_secret_12345", label: "Ads" },
  });
  expect(res.status).toBe(200);
  const started = (await res.json()) as {
    status: string;
    server: {
      id: string;
      tools: {
        name: string;
        level: string;
        sensitive: boolean;
        pending: boolean;
        suggestionReason: string | null;
        subject: string;
        nameParts: { verb: string | null; words: string[] };
      }[];
    };
  };
  expect(started.status).toBe("connected");
  const by = Object.fromEntries(started.server.tools.map((x) => [x.name, x]));
  expect(by.campaign_list).toMatchObject({ level: "read", sensitive: false, pending: false, subject: "campaign" });
  expect(by.campaign_delete).toMatchObject({ level: "approval", sensitive: true, pending: false });
  expect(by.pixel_track).toMatchObject({
    level: "write",
    pending: true,
    suggestionReason: "changes_undoable",
    nameParts: { verb: "track", words: ["pixel"] },
  });

  const save = (access: string, name = "campaign_delete") =>
    owner(`/api/app/organizations/${orgId}/connectors/custom/${started.server.id}/tools`, {
      method: "PUT",
      json: { label: "Ads", tools: [{ name, access, label: name }] },
    });
  expect((await save("read")).status).toBe(400);
  expect((await save("write")).status).toBe(400);
  expect((await save("off")).status).toBe(200);
  const ok = (await (await save("approval", "pixel_track")).json()) as { tools: { name: string; pending: boolean }[] };
  expect(ok.tools.find((x) => x.name === "pixel_track")?.pending).toBe(false);
});
