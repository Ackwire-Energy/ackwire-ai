import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  agentRepositoryList,
  type ConnectorDeps,
  cleanRepoList,
  connectorGrantValidator,
  createApiKeyConnection,
  createConnectorToolSource,
  createGitToolSource,
  createToolGateway,
  ForbiddenError,
  getAgentRepositories,
  invokeToolForRun,
  listOrgRepositories,
  listRuns,
  normalizeRepoEntry,
  postPersonMessage,
  repoInList,
  repositoriesPrompt,
  reposOfGithubCall,
  setAgentRepositories,
  setAgentScopes,
  type ToolContext,
  takeBridgeEffects,
  ValidationError,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PUBLIC_URL = "https://agentes.test";
const API = "https://api.github.test";
const depsOf = (fx: Fixture): ConnectorDeps => ({ db: fx.db, keyWrappers: [fx.keyWrapper], publicUrl: PUBLIC_URL });

describe("the list", () => {
  test("entries: owner/name, owner/*, URLs and .git; anything else is refused", () => {
    expect(normalizeRepoEntry(" acme/app ")).toBe("acme/app");
    expect(normalizeRepoEntry("https://github.com/acme/app.git")).toBe("acme/app");
    expect(normalizeRepoEntry("git@github.com:acme/app.git")).toBe("acme/app");
    expect(normalizeRepoEntry("acme/*")).toBe("acme/*");
    for (const bad of ["acme", "acme/app/x", "/app", "acme/..", "ac me/app", "*/app", ""]) {
      expect(normalizeRepoEntry(bad)).toBeNull();
    }
  });

  test("matching is case-insensitive; owner/* takes the whole account; empty allows everything", () => {
    expect(repoInList([], "x", "y")).toBe(true);
    expect(repoInList(["Acme/App"], "acme", "app")).toBe(true);
    expect(repoInList(["acme/app"], "acme", "api")).toBe(false);
    expect(repoInList(["acme/*"], "ACME", "anything")).toBe(true);
    expect(repoInList(["acme/*"], "beta", "app")).toBe(false);
  });

  test("cleaning keeps the order, drops repeats and repositories an account already covers", () => {
    expect(cleanRepoList(["acme/api", "walt/notes", "ACME/api", "acme/*", "acme/web", "nope"])).toEqual({
      list: ["walt/notes", "acme/*"],
      invalid: ["nope"],
    });
  });

  test("the repositories a call names: owner + repo, repo, or a search's repo: qualifiers", () => {
    expect(reposOfGithubCall({ owner: "acme", repo: "app", pullNumber: 1 })).toEqual(["acme/app"]);
    expect(reposOfGithubCall({ repo: "https://github.com/acme/app" })).toEqual(["acme/app"]);
    expect(reposOfGithubCall({ query: "token repo:acme/app repo:acme/api" })).toEqual(["acme/app", "acme/api"]);
    // A search over whole accounts, or with no repository: names none.
    expect(reposOfGithubCall({ query: "token repo:acme/app org:beta" })).toBeNull();
    expect(reposOfGithubCall({ query: "token" })).toBeNull();
    expect(reposOfGithubCall({ number: 1 })).toBeNull();
  });

  test("the prompt says the repositories and where to start", () => {
    expect(repositoriesPrompt([])).toBe("");
    const text = repositoriesPrompt(["acme/app", "walt/*"]);
    expect(text).toContain("# Your GitHub repositories");
    expect(text).toContain("acme/app, every repository of walt (walt/*)");
    expect(text).toContain("When nobody names a repository, work in acme/app.");
    expect(repositoriesPrompt(["walt/*"])).toContain("search the repositories of walt first (search_code)");
  });
});

describe("saving", () => {
  test("in order, by admins or the agent's owner; audited", async () => {
    f = await setup();
    expect(await getAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([]);
    expect(
      await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["walt/notes", "acme/app", "acme/app"]),
    ).toEqual(["walt/notes", "acme/app"]);
    expect(await agentRepositoryList(f.db, f.org.id, f.agent.id)).toEqual(["walt/notes", "acme/app"]);
    // Reordered: the first is where it starts.
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "walt/notes"]);
    expect(await getAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual(["acme/app", "walt/notes"]);

    await expect(setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme"])).rejects.toBeInstanceOf(
      ValidationError,
    );
    const member = await addMember(f.db, f.org.id, "member");
    await expect(setAgentRepositories(f.db, member.id, f.org.id, f.agent.id, [])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Members read it.
    expect(await getAgentRepositories(f.db, member.id, f.org.id, f.agent.id)).toEqual(["acme/app", "walt/notes"]);
    // The agent's owner (not an admin) changes it.
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    expect(await setAgentRepositories(f.db, member.id, f.org.id, f.agent.id, [])).toEqual([]);
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.repositories_changed"));
    expect(audits.map((a) => a.details)).toEqual([
      { repositories: ["walt/notes", "acme/app"] },
      { repositories: ["acme/app", "walt/notes"] },
      { repositories: [] },
    ]);
  });
});

async function runContext(fx: Fixture): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

describe("enforcement in the Tool Gateway", () => {
  test("GitHub MCP tools: only the agent's repositories, before running or asking for approval", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      ["github:pr.read", "github:pr.merge", "github:issues.read"].map((scope) => ({ connectionId: c.id, scope })),
      connectorGrantValidator,
    );
    const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(f), connect: mcp.connect })] });
    const ctx = await runContext(f);
    const pr = (owner: string, repo: string) => ({ owner, repo, pullNumber: 4 });

    // No list: every repository; the result says which one it touched.
    expect(
      await gateway.invoke(ctx, { toolUseId: "a", name: "github_get_pull_request", input: pr("x", "y") }),
    ).toMatchObject({ type: "result", output: { data: { repo: "x/y" } } });

    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "walt/*"]);
    expect(
      await gateway.invoke(ctx, { toolUseId: "b", name: "github_get_pull_request", input: pr("acme", "app") }),
    ).toMatchObject({ type: "result", output: { content: "PR #4: fix token refresh (checks passing)" } });
    expect(
      await gateway.invoke(ctx, { toolUseId: "c", name: "github_get_pull_request", input: pr("walt", "anything") }),
    ).toMatchObject({ type: "result", output: { data: { repo: "walt/anything" } } });

    const denied = await gateway.invoke(ctx, {
      toolUseId: "d",
      name: "github_get_pull_request",
      input: pr("acme", "infra"),
    });
    expect(denied).toMatchObject({ type: "result", output: { isError: true, data: { deniedRepo: "acme/infra" } } });
    expect(denied.type === "result" && denied.output.content).toContain(
      "acme/infra isn't one of your GitHub repositories",
    );

    // A merge outside the list: refused, no approval asked.
    const merge = await gateway.invoke(ctx, {
      toolUseId: "e",
      name: "github_merge_pull_request",
      input: pr("acme", "infra"),
    });
    expect(merge).toMatchObject({ type: "result", output: { isError: true, data: { deniedRepo: "acme/infra" } } });
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    // Inside the list it still asks a person.
    expect(
      (await gateway.invoke(ctx, { toolUseId: "f", name: "github_merge_pull_request", input: pr("acme", "app") })).type,
    ).toBe("approval");

    // A call that names no repository can't run while the agent has a list.
    expect(await gateway.invoke(ctx, { toolUseId: "g", name: "github_get_issue", input: { number: 1 } })).toMatchObject(
      {
        type: "result",
        output: { isError: true, data: {} },
      },
    );
    expect(mcp.calls.map((x) => `${x.tool} ${x.args.owner}/${x.args.repo}`)).toEqual([
      "get_pull_request x/y",
      "get_pull_request acme/app",
      "get_pull_request walt/anything",
    ]);
  });

  test("a computer brain's calls through the runner bridge get the same limits, and the run keeps the refusal", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: c.id, scope: "github:pr.read" }],
      connectorGrantValidator,
    );
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    const tools = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(f), connect: mcp.connect })] });
    const ctx = await runContext(f);
    // The engine builds the transcript before a computer turn; the bridge keeps effects on it.
    await f.db.update(schema.agentRuns).set({ transcript: {} }).where(eq(schema.agentRuns.id, ctx.runId));
    const deps = { db: f.db, pubsub: f.pubsub, tools };
    const id = { orgId: f.org.id, agentId: f.agent.id, runId: ctx.runId, machineId: "m-1" };
    const pr = (owner: string, repo: string) => ({ owner, repo, pullNumber: 4 });

    const denied = await invokeToolForRun(deps, id, {
      id: "b-1",
      name: "github_get_pull_request",
      input: pr("acme", "infra"),
    });
    expect(denied).toMatchObject({ result: { isError: true }, code: "tool.not_allowed" });
    expect(denied.result.content).toContain("acme/infra isn't one of your GitHub repositories");
    const allowed = await invokeToolForRun(deps, id, {
      id: "b-2",
      name: "github_get_pull_request",
      input: pr("acme", "app"),
    });
    expect(allowed.result.isError).toBeUndefined();
    expect(mcp.calls.map((x) => `${x.tool} ${x.args.owner}/${x.args.repo}`)).toEqual(["get_pull_request acme/app"]);
    // What the engine takes at the end of the turn: the refused repository and the one it worked in.
    expect(await takeBridgeEffects(f.db, ctx.runId)).toMatchObject({ deniedRepo: "acme/infra", repo: "acme/app" });
  });

  test("open_pull_request outside the list never reaches GitHub", async () => {
    f = await setup();
    const connectors = depsOf(f);
    const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: connection.id, scope: "github:pr.write" }],
      connectorGrantValidator,
    );
    const calls: string[] = [];
    const github = {
      apiUrl: API,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (String(input).endsWith("/pulls"))
          return Response.json({ number: 9, html_url: "https://x/9" }, { status: 201 });
        return Response.json({ default_branch: "main" });
      }) as typeof fetch,
    };
    const gateway = createToolGateway({
      sources: [createGitToolSource({ sandbox: {} as never, connectors, github })],
    });
    const ctx = await runContext(f);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    const open = (repo: string, id: string) =>
      gateway.invoke(ctx, {
        toolUseId: id,
        name: "open_pull_request",
        input: { repo, branch: "agentes/dev/x", title: "t" },
      });
    expect(await open("acme/infra", "a")).toMatchObject({
      output: { isError: true, data: { deniedRepo: "acme/infra" } },
    });
    expect(calls).toEqual([]);
    expect(await open("acme/app", "b")).toMatchObject({ output: { content: "Opened PR #9: https://x/9" } });
    expect(calls).toEqual([`GET ${API}/repos/acme/app`, `POST ${API}/repos/acme/app/pulls`]);
  });
});

test("runs say the repository they worked in and the one they were refused", async () => {
  f = await setup();
  const ctx = await runContext(f);
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: { repo: "acme/app", deniedRepo: "acme/infra" } })
    .where(eq(schema.agentRuns.id, ctx.runId));
  const [run] = await listRuns(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  expect(run).toMatchObject({ repo: "acme/app", deniedRepo: "acme/infra" });
});

describe("the organization's repositories", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const APP = { appId: "1", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  const repo = (full: string, extra: Record<string, unknown> = {}) => ({
    full_name: full,
    name: full.split("/")[1],
    private: true,
    pushed_at: "2026-10-01T00:00:00Z",
    owner: { login: full.split("/")[0], type: full.startsWith("acme/") ? "Organization" : "User" },
    ...extra,
  });

  test("the connection's and the bound installations', merged by account, cached, without tokens", async () => {
    f = await setup();
    await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_user_token" });
    await f.db
      .insert(schema.githubAppInstallations)
      .values([{ orgId: f.org.id, installationId: 7, accountLogin: "acme", accountType: "Organization" }]);
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls.push(`${init?.method ?? "GET"} ${url.replace(API, "")} ${auth.startsWith("Bearer ey") ? "jwt" : auth}`);
      if (url.startsWith(`${API}/user/repos`)) {
        return Response.json([
          repo("walt/notes", { pushed_at: "2026-10-10T00:00:00Z" }),
          repo("acme/app", { private: false }),
          repo("walt/old", { pushed_at: "2025-01-01T00:00:00Z" }),
        ]);
      }
      if (url.endsWith("/app/installations/7/access_tokens"))
        return Response.json({ token: "ghs_inst" }, { status: 201 });
      if (url.startsWith(`${API}/installation/repositories`)) {
        return Response.json({ repositories: [repo("acme/app"), repo("acme/infra")] });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof globalThis.fetch;
    const deps = { db: f.db, connectors: depsOf(f), app: APP, github: { apiUrl: API, fetch } };

    const listing = await listOrgRepositories(deps, f.owner.id, f.org.id);
    expect(listing.connected).toBe(true);
    expect(listing.truncated).toBe(false);
    expect(listing.accounts.map((a) => [a.login, a.type, a.repositories.map((r) => r.name)])).toEqual([
      ["acme", "Organization", ["app", "infra"]],
      ["walt", "User", ["notes", "old"]],
    ]);
    // The installation's copy of acme/app came last (private).
    expect(listing.accounts[0]?.repositories[0]).toMatchObject({ fullName: "acme/app", private: true });
    expect(JSON.stringify(listing)).not.toContain("ghp_");
    expect(JSON.stringify(listing)).not.toContain("ghs_");
    expect(calls).toEqual([
      "GET /user/repos?per_page=100&page=1&sort=pushed&affiliation=owner,collaborator,organization_member Bearer ghp_user_token",
      "POST /app/installations/7/access_tokens jwt",
      "GET /installation/repositories?per_page=100&page=1 Bearer ghs_inst",
    ]);
    // Cached for a minute.
    await listOrgRepositories(deps, f.owner.id, f.org.id);
    expect(calls).toHaveLength(3);
    // Members can read it; an installation of another organization never counts.
    const member = await addMember(f.db, f.org.id, "member");
    expect((await listOrgRepositories(deps, member.id, f.org.id)).accounts).toHaveLength(2);
  });

  test("no GitHub: not connected, nothing listed", async () => {
    f = await setup();
    const listing = await listOrgRepositories(
      { db: f.db, connectors: depsOf(f), app: null, github: { apiUrl: API, fetch: (() => Promise.reject()) as never } },
      f.owner.id,
      f.org.id,
    );
    expect(listing).toEqual({ connected: false, accounts: [], truncated: false });
  });
});
