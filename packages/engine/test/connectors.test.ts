import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  completeOAuth,
  connectionHeaders,
  connectorGrantValidator,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  drainOutbox,
  ForbiddenError,
  fillTitle,
  listApprovals,
  listMessages,
  postPersonMessage,
  revokeConnection,
  setAgentScopes,
  startOAuth,
  ValidationError,
  wrapExternal,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const depsOf = (fx: Fixture, extra: Partial<ConnectorDeps> = {}): ConnectorDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  oauthApps: { github: { clientId: "gh-client", clientSecret: "gh-secret" } },
  ...extra,
});

test("fillTitle fills approval templates", () => {
  expect(fillTitle("Merge PR #{pullNumber} in {owner}/{repo}", { pullNumber: 42, owner: "acme", repo: "app" })).toBe(
    "Merge PR #42 in acme/app",
  );
  expect(fillTitle("{missing}", {})).toBe("?");
});

describe("connections", () => {
  test("API-key connection: sealed at rest, admins only, one active per connector", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      createApiKeyConnection(depsOf(f), member.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "jira", apiKey: "x".repeat(10) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
        connector: "github",
        apiKey: "ghp_secret_123456",
        serverUrl: "http://evil.example/mcp",
      }),
    ).rejects.toThrow("https");

    const first = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const raw = JSON.stringify(await f.db.select().from(schema.connectorConnections));
    expect(raw).not.toContain("ghp_secret_123456");
    expect(await connectionHeaders(depsOf(f), first)).toEqual({ authorization: "Bearer ghp_secret_123456" });

    // Grants survive reconnecting.
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: first.id, scope: "github:pr.read" }],
      connectorGrantValidator,
    );
    const second = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_rotated_654321",
    });
    const scopes = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
    expect(scopes.find((s) => s.scope === "github:pr.read")?.connectionId).toBe(second.id);
    const active = (await f.db.select().from(schema.connectorConnections)).filter((c) => !c.revokedAt);
    expect(active.map((c) => c.id)).toEqual([second.id]);
  });

  test("grants must name a scope of the connection's catalog, in this org", async () => {
    f = await setup();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const set = (grants: { connectionId: string | null; scope: string }[]) =>
      setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, grants, connectorGrantValidator);
    await expect(set([{ connectionId: c.id, scope: "github:admin" }])).rejects.toThrow("Unknown scope");
    await expect(set([{ connectionId: c.id, scope: "sentry:issues.read" }])).rejects.toThrow("Unknown scope");
    await expect(set([{ connectionId: null, scope: "root" }])).rejects.toThrow("Unknown scope");
    await expect(set([{ connectionId: crypto.randomUUID(), scope: "github:pr.read" }])).rejects.toThrow(
      "not an active",
    );
    await set([
      { connectionId: c.id, scope: "github:pr.read" },
      { connectionId: null, scope: "context:read" },
    ]);
  });
});

describe("MCP tools through the Tool Gateway", () => {
  test("only catalog tools the agent was granted are exposed; calls go over MCP with the org's key", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const source = createConnectorToolSource({ ...depsOf(f), connect: mcp.connect });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const all = await source.tools(ctx);
    expect(all.map((t) => [t.name, t.scope, t.sensitive]).sort()).toEqual([
      ["github_get_issue", "github:issues.read", false],
      ["github_get_pull_request", "github:pr.read", false],
      ["github_merge_pull_request", "github:pr.merge", true],
    ]);
    expect(mcp.sessions[0]).toEqual({
      serverUrl: "https://api.githubcopilot.com/mcp/",
      headers: { authorization: "Bearer ghp_secret_123456" },
    });

    const gateway = createToolGateway({ sources: [source] });
    expect(await gateway.list(ctx)).toEqual([]);
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [
        { connectionId: c.id, scope: "github:pr.read" },
        { connectionId: c.id, scope: "github:issues.read" },
      ],
      connectorGrantValidator,
    );
    expect((await gateway.list(ctx)).map((t) => t.name)).toEqual(["github_get_issue", "github_get_pull_request"]);

    // Grant rows need a run for steps; use a real one.
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
    const rctx = { ...ctx, runId: run?.id ?? "" };
    expect(
      await gateway.invoke(rctx, {
        toolUseId: "t1",
        name: "github_get_pull_request",
        input: { owner: "acme", repo: "app", pullNumber: 42 },
      }),
    ).toMatchObject({
      type: "result",
      // The MCP server's text is third-party data: wrapped for the model.
      output: { content: wrapExternal("github_get_pull_request", "PR #42: fix token refresh (checks passing)") },
    });
    expect(
      await gateway.invoke(rctx, { toolUseId: "t2", name: "github_get_issue", input: { number: 1 } }),
    ).toMatchObject({
      output: { content: wrapExternal("github_get_issue", "boom"), isError: true },
    });
    expect(
      await gateway.invoke(rctx, { toolUseId: "t3", name: "github_delete_repository", input: { repo: "app" } }),
    ).toMatchObject({
      output: { content: "Unknown tool github_delete_repository", isError: true },
    });
    expect(mcp.calls.map((c) => c.tool)).toEqual(["get_pull_request"]);

    // Disconnecting removes the tools and the grants.
    await revokeConnection(f.db, f.owner.id, f.org.id, c.id);
    expect(await gateway.list(ctx)).toEqual([]);
    expect(await f.db.select().from(schema.agentScopes)).toEqual([]);
  });

  test("end to end: mention → MCP read → merge approval → approve → merged over MCP with exactly the approved params", async () => {
    const mcp = fakeGithubMcp();
    let deps: ConnectorDeps | undefined;
    f = await setup({
      toolSources: [
        {
          name: "lazy-connectors",
          tools: (ctx) => createConnectorToolSource({ ...(deps as ConnectorDeps), connect: mcp.connect }).tools(ctx),
        },
      ],
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("Merged PR #42")) return { chunks: ["Merge feito."] };
        if (last.includes("checks passing"))
          return {
            chunks: ["Checks passing."],
            toolUses: [{ name: "github_merge_pull_request", input: { owner: "acme", repo: "app", pullNumber: 42 } }],
          };
        return {
          chunks: [],
          toolUses: [{ name: "github_get_pull_request", input: { owner: "acme", repo: "app", pullNumber: 42 } }],
        };
      },
    });
    deps = depsOf(f);
    const c = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [
        { connectionId: c.id, scope: "github:pr.read" },
        { connectionId: c.id, scope: "github:pr.merge" },
      ],
      connectorGrantValidator,
    );

    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev merge PR 42",
    });
    await drainOutbox(f.db, f.handlers);
    const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
    expect(approval).toMatchObject({
      title: "Merge PR #42 in acme/app",
      scope: "github:pr.merge",
      tool: "github_merge_pull_request",
    });
    expect(approval?.detail).toBe("github.merge_pull_request · owner=acme · repo=app · pullNumber=42");
    expect(mcp.calls.map((x) => x.tool)).toEqual(["get_pull_request"]);

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect(mcp.calls).toEqual([
      { tool: "get_pull_request", args: { owner: "acme", repo: "app", pullNumber: 42 } },
      { tool: "merge_pull_request", args: { owner: "acme", repo: "app", pullNumber: 42 } },
    ]);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Merge feito.");
  });
});

describe("OAuth (state + PKCE)", () => {
  /** A token endpoint that checks the PKCE verifier against the challenge from the authorize URL. */
  function tokenEndpoint() {
    const seen: URLSearchParams[] = [];
    let challenge = "";
    let n = 0;
    const http = (async (_url: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      seen.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const ok =
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") === challenge;
        if (!ok || form.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      n++;
      return Response.json({ access_token: `gho_token_${n}`, refresh_token: `ghr_refresh_${n}`, expires_in: 3600 });
    }) as unknown as typeof fetch;
    return { http, seen, setChallenge: (c: string) => (challenge = c) };
  }

  test("start → callback stores sealed tokens; state is single use, per person, and expires", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github", {
      returnTo: "/settings/connectors",
    });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "gh-client",
      redirect_uri: "https://chat.example.com/api/app/connectors/oauth/callback",
      response_type: "code",
      scope: "repo read:org workflow",
      state,
      code_challenge_method: "S256",
    });
    token.setChallenge(url.searchParams.get("code_challenge") ?? "");
    const stored = JSON.stringify(await f.db.select().from(schema.oauthStates));
    expect(stored).not.toContain(state);

    const other = await addMember(f.db, f.org.id, "admin", "other");
    await expect(completeOAuth(deps, { id: other.id }, { state, code: "good-code" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(completeOAuth(deps, { id: f.owner.id }, { state: "forged", code: "good-code" })).rejects.toThrow(
      "invalid or expired",
    );

    const { connection, returnTo } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    expect(returnTo).toBe("/settings/connectors");
    expect(connection).toMatchObject({ connector: "github", authType: "oauth" });
    expect(JSON.stringify(await f.db.select().from(schema.connectorConnections))).not.toContain("gho_token_1");
    expect(await connectionHeaders(deps, connection)).toEqual({ authorization: "Bearer gho_token_1" });
    expect(token.seen[0]?.get("client_secret")).toBe("gh-secret");

    await expect(completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" })).rejects.toThrow(
      "invalid or expired",
    );

    const late = await startOAuth(deps, f.owner.id, f.org.id, "github");
    const later = depsOf(f, { http: token.http, now: () => new Date(Date.now() + 11 * 60_000) });
    await expect(completeOAuth(later, { id: f.owner.id }, { state: late.state, code: "good-code" })).rejects.toThrow(
      "expired",
    );
  });

  test("a wrong PKCE verifier or code is refused by the provider; unconfigured OAuth is refused", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const { state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    token.setChallenge("something-else");
    await expect(completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" })).rejects.toThrow(
      "invalid_grant",
    );
    await expect(startOAuth(deps, f.owner.id, f.org.id, "linear")).rejects.toThrow("not configured");
  });

  test("tokens about to expire are refreshed before a call", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    token.setChallenge(new URL(authorizeUrl).searchParams.get("code_challenge") ?? "");
    const { connection } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    const soon = depsOf(f, { http: token.http, now: () => new Date(Date.now() + 3590_000) });
    expect(await connectionHeaders(soon, connection)).toEqual({ authorization: "Bearer gho_token_2" });
    expect(token.seen.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(token.seen.at(-1)?.get("refresh_token")).toBe("ghr_refresh_1");
  });
});
