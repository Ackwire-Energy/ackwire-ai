import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONNECTOR_BRANDS,
  type ConnectorDeps,
  completeOAuth,
  connectorListing,
  createApiKeyConnection,
  MCP_PRESETS,
  mcpPreset,
  presetForServer,
  probeMcpServer,
  revokeAtProvider,
  startOAuth,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("one-click MCP connectors", () => {
  test("presets are official https servers with unique ids; matched by canonical URL", () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of MCP_PRESETS) expect(p.serverUrl.startsWith("https://")).toBe(true);
    expect(ids).not.toContain("hubspot");
    expect(ids).not.toContain("vercel");
    expect(mcpPreset("linear")?.serverUrl).toBe("https://mcp.linear.app/mcp");
    expect(presetForServer("https://mcp.linear.app/mcp/")?.id).toBe("linear");
    expect(presetForServer("https://example.com/mcp")).toBeNull();
  });

  test("every connector in the catalog has a logo the web app serves", () => {
    const web = resolve(import.meta.dir, "../../../apps/web/public");
    for (const b of Object.values(CONNECTOR_BRANDS)) {
      expect(existsSync(`${web}/${b.own ? "brands" : "connectors"}/${b.file}.svg`)).toBe(true);
    }
    const missing = connectorListing({})
      .filter((e) => !e.iconUrl)
      .map((e) => e.id);
    expect(missing).toEqual([]);
  });

  test("a server without protected-resource metadata: OAuth at its own origin when it registers clients", async () => {
    const http = (async (url: string) => {
      if (url === "https://mcp.atlassian.com/v1/mcp") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="OAuth"' } });
      }
      if (url === "https://mcp.atlassian.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://mcp.atlassian.com",
          authorization_endpoint: "https://mcp.atlassian.com/v1/authorize",
          token_endpoint: "https://mcp.atlassian.com/v1/token",
          registration_endpoint: "https://mcp.atlassian.com/v1/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    f = await setup();
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      http,
      resolveHost: async () => ["93.184.216.34"],
    };
    expect(await probeMcpServer(deps, "https://mcp.atlassian.com/v1/mcp")).toEqual({
      kind: "oauth",
      resource: "https://mcp.atlassian.com/v1/mcp",
      issuer: "https://mcp.atlassian.com",
      scopes: [],
    });
  });
});

describe("GitHub with our OAuth app", () => {
  test("disconnecting also revokes the grant at GitHub (basic auth with the app); API keys are left alone", async () => {
    f = await setup();
    const calls: { url: string; method: string; auth: string | null; body: string }[] = [];
    const http = (async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("authorization"),
        body: String(init.body ?? ""),
      });
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({ access_token: "gho_token_1", token_type: "bearer", scope: "repo,read:org,workflow" });
      }
      if (url.includes("/applications/gh-client/grant")) return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const deps: ConnectorDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://app.example.com",
      oauthApps: { github: { clientId: "gh-client", clientSecret: "gh-secret" } },
      http,
    };
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/app/connectors/oauth/callback",
    );
    const { connection } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    expect(await revokeAtProvider(deps, f.org.id, connection.id)).toBe(true);
    const revoke = calls.find((c) => c.method === "DELETE");
    expect(revoke?.url).toBe("https://api.github.com/applications/gh-client/grant");
    expect(revoke?.auth).toBe(`Basic ${Buffer.from("gh-client:gh-secret").toString("base64")}`);
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: "gho_token_1" });

    const keyed = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "sentry",
      apiKey: "sntrys_secret_123456",
    });
    expect(await revokeAtProvider(deps, f.org.id, keyed.id)).toBe(false);
  });
});
