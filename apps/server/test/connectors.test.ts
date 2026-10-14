import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  expect(catalog.connectors.find((c) => c.id === "linear")?.oauthConfigured).toBe(false);
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
