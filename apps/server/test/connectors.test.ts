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
  // Connected without the web's dialog (the API, the phone): every agent has it whole, as the dialog starts.
  const access = (await (await owner(`/api/app/organizations/${orgId}/agents/${agentId}/access`)).json()) as {
    connectors: { connectionId: string; state: string }[];
  };
  expect(access.connectors.find((c) => c.connectionId === sentry.id)?.state).toBe("granted");

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

test("connectors API: the phone app's OAuth hands the code back to the app, which finishes with its session", async () => {
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
    // A second person (the stranger below) signs up too.
    env: { ALLOW_SIGNUP: "true", CONNECTOR_GITHUB_CLIENT_ID: "gh-id", CONNECTOR_GITHUB_CLIENT_SECRET: "gh-secret" },
  });
  // The phone app: our cookie, no Origin, the app's header.
  const app = browser(t);
  await signUp(app, "owner@example.com");
  const { orgId } = await seedOrg(app);
  const mobile = { origin: null, headers: { "x-agentes-client": "mobile" } };
  const start = async (returnTo: string) => {
    const res = await app(`/api/app/organizations/${orgId}/connectors/github/oauth/start`, {
      ...mobile,
      json: { returnTo },
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    challenge = url.searchParams.get("code_challenge") ?? "";
    return url.searchParams.get("state") ?? "";
  };

  // The system browser comes back without our session: the callback only hands state and code to the app.
  const state = await start("app:connectors");
  const systemBrowser = browser(t);
  const back = await systemBrowser(`/api/app/connectors/oauth/callback?state=${state}&code=abc`, { origin: null });
  expect(back.status).toBe(302);
  const deepLink = new URL(back.headers.get("location") ?? "");
  expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe("agenteschat://connectors/oauth");
  expect(deepLink.searchParams.get("state")).toBe(state);
  expect(deepLink.searchParams.get("code")).toBe("abc");
  const none = (await (await app(`/api/app/organizations/${orgId}/connectors`, mobile)).json()) as {
    connections: unknown[];
  };
  expect(none.connections).toHaveLength(0);

  // Someone else can't finish it (the state stays bound to who started it, and stays usable).
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  const stolen = await stranger(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state, code: "abc" },
  });
  expect([403, 404]).toContain(stolen.status);

  // The app finishes with its own session.
  const done = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state, code: "abc" },
  });
  expect(done.status).toBe(200);
  expect(((await done.json()) as { connector: string }).connector).toBe("github");
  const conns = (await (await app(`/api/app/organizations/${orgId}/connectors`, mobile)).json()) as {
    connections: { connector: string; authType: string }[];
  };
  expect(conns.connections.map((c) => [c.connector, c.authType])).toEqual([["github", "oauth"]]);
  // Once only.
  const replay = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state, code: "abc" },
  });
  expect(replay.status).toBe(404);

  // A web authorization can't be finished through the app's route.
  const webState = await start("/settings");
  const crossed = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state: webState, code: "abc" },
  });
  expect(crossed.status).toBe(404);

  // Refused at the provider: the app hears why.
  const refused = await start("app:connectors");
  const no = await systemBrowser(`/api/app/connectors/oauth/callback?state=${refused}&error=access_denied`, {
    origin: null,
  });
  expect(no.headers.get("location")).toBe("agenteschat://connectors/oauth?error=access_denied");

  // Started in the desktop app's window: the browser hands it back to the app, with the organization, and the
  // window finishes with its own session, landing where it started.
  const desktop = await start("desktop:/org/x/settings/connectors");
  const toDesktop = await systemBrowser(`/api/app/connectors/oauth/callback?state=${desktop}&code=abc`, {
    origin: null,
  });
  const desktopLink = new URL(toDesktop.headers.get("location") ?? "");
  expect(`${desktopLink.protocol}//${desktopLink.host}${desktopLink.pathname}`).toBe(
    "agenteschat://desktop/connectors/oauth",
  );
  expect(desktopLink.searchParams.get("org")).toBe(orgId);
  expect(desktopLink.searchParams.get("state")).toBe(desktop);
  const stolenDesktop = await stranger(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state: desktop, code: "abc" },
  });
  expect([403, 404]).toContain(stolenDesktop.status);
  const fromWindow = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state: desktop, code: "abc" },
  });
  expect(fromWindow.status).toBe(200);
  expect(await fromWindow.json()).toMatchObject({ connector: "github", returnTo: "/org/x/settings/connectors" });
  const refusedDesktop = await start("desktop:/org/x/settings/connectors");
  const noDesktop = await systemBrowser(
    `/api/app/connectors/oauth/callback?state=${refusedDesktop}&error=access_denied`,
    { origin: null },
  );
  expect(noDesktop.headers.get("location")).toBe(
    `agenteschat://desktop/connectors/oauth?org=${orgId}&error=access_denied`,
  );

  // A web callback without our session asks to sign in instead of failing silently.
  const webAgain = await start("/settings");
  const signedOut = await systemBrowser(`/api/app/connectors/oauth/callback?state=${webAgain}&code=abc`, {
    origin: null,
  });
  expect(signedOut.headers.get("location")).toBe("http://localhost:3000/?connector_error=sign_in");
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
  // A one-color mark (Square's black) and two in their makers' colors.
  expect(byId("square")).toMatchObject({ iconUrl: "/connectors/square.svg", brandColor: null });
  expect(byId("paypal")).toMatchObject({ iconUrl: "/brands/paypal.svg", brandColor: null });
  expect(byId("canva")).toMatchObject({ iconUrl: "/brands/canva.svg", brandColor: null });
  // Every connector in the catalog has its mark, a file in the web app: none is left a monogram.
  const publicDir = new URL("../../web/public", import.meta.url).pathname;
  for (const c of connectors) {
    expect([c.id, c.iconUrl !== null && existsSync(`${publicDir}${c.iconUrl}`)]).toEqual([c.id, true]);
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
