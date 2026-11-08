import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { schema } from "@agenteschat/db";
import {
  appPermissionsFor,
  type ConnectorDeps,
  createApiKeyConnection,
  createConnectorToolSource,
  type GitHubAppConfig,
  SIGNATURE_MARK,
  syncGitHubAppConnection,
  type ToolContext,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP: GitHubAppConfig = {
  appId: "123",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  slug: "agentes-chat",
};
const API = "https://api.github.test";

/** GitHub's REST API for the app: `acme/*` is installation 1's; the person's GitHub account is 583231. */
function fakeRest() {
  const minted: { body: Record<string, unknown> }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (/\/repos\/acme\/[^/]+\/installation$/.test(url)) return Response.json({ id: 1 });
    if (url.includes("/repos/")) return new Response("not found", { status: 404 });
    if (url.endsWith("/app/installations/1/access_tokens")) {
      minted.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json(
        { token: `ghs_app_${minted.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 },
      );
    }
    if (url === `${API}/user/583231`) return Response.json({ login: "ana-gh" });
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch: fake, minted };
}

async function world(options: { account?: boolean } = {}) {
  f = await setup();
  const mcp = fakeGithubMcp({ writes: true });
  const rest = fakeRest();
  const deps: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" };
  if (options.account) {
    await createApiKeyConnection(deps, f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" });
  }
  await f.db.insert(schema.githubAppInstallations).values({
    orgId: f.org.id,
    installationId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    createdByUserId: f.owner.id,
  });
  await syncGitHubAppConnection(f.db, f.org.id, { type: "person", id: f.owner.id });
  const source = createConnectorToolSource({
    ...deps,
    connect: mcp.connect,
    githubApp: { app: () => APP, http: { fetch: rest.fetch, apiUrl: API } },
  });
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: crypto.randomUUID(),
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
  };
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = (await source.tools(ctx)).find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const before = mcp.sessions.length;
    const out = await tool.execute(input, ctx);
    const session = mcp.sessions.length > before ? mcp.sessions.at(-1) : undefined;
    return { out, auth: session?.headers.authorization, args: mcp.calls.at(-1)?.args };
  };
  return { mcp, rest, source, ctx, call };
}

describe("GitHub's tools act as the app where it is installed (ADR 0153)", () => {
  test("what the app's token may do, by the tool's scope: most first, never Projects", () => {
    expect(appPermissionsFor("push_files", "repo.write")).toEqual([
      { contents: "write", workflows: "write" },
      { contents: "write" },
    ]);
    expect(appPermissionsFor("pull_request_read", "pr.read")).toEqual([
      { pull_requests: "read", checks: "read", statuses: "read" },
    ]);
    expect(appPermissionsFor("merge_pull_request", "pr.merge")).toEqual([
      { contents: "write", pull_requests: "write" },
    ]);
    expect(appPermissionsFor("update_pull_request_branch", "pr.write")).toEqual([
      { pull_requests: "write", contents: "write" },
    ]);
    expect(appPermissionsFor("actions_run_trigger", "actions.run")).toEqual([{ actions: "write" }]);
    expect(appPermissionsFor("projects_list", "projects.read")).toBeNull();
  });

  test("a covered repository goes with its app token; anywhere else with the account, as before", async () => {
    const w = await world({ account: true });
    const covered = await w.call("github_add_issue_comment", {
      owner: "acme",
      repo: "api",
      issue_number: 4,
      body: "Done",
    });
    expect(covered.auth).toBe("Bearer ghs_app_1");
    expect(w.rest.minted.at(-1)?.body).toEqual({ repositories: ["api"], permissions: { issues: "write" } });
    const elsewhere = await w.call("github_add_issue_comment", {
      owner: "other",
      repo: "x",
      issue_number: 1,
      body: "Hi",
    });
    expect(elsewhere.auth).toBe("Bearer ghp_secret_123456");
    // An account named alone: that installation's token.
    expect((await w.call("github_list_issue_types", { owner: "acme" })).auth).toBe("Bearer ghs_app_2");
    expect((await w.call("github_list_issue_types", { owner: "someone" })).auth).toBe("Bearer ghp_secret_123456");
  });

  test("through the app alone: listed with the installation's token, Projects hidden, uncovered repositories refused", async () => {
    const w = await world();
    const listed = (await w.source.tools(w.ctx)).map((t) => t.name);
    expect(listed).toContain("github_add_issue_comment");
    expect(listed).not.toContain("github_projects_list");
    expect(w.mcp.sessions[0]?.headers.authorization).toBe("Bearer ghs_app_1");
    expect(w.rest.minted[0]?.body).toEqual({ permissions: { metadata: "read" } });

    const refused = await w.call("github_add_issue_comment", {
      owner: "other",
      repo: "x",
      issue_number: 1,
      body: "Hi",
    });
    expect(refused.out).toMatchObject({ isError: true });
    expect(refused.out.content).toContain("isn't installed on other/x");
    expect(refused.auth).toBeUndefined();
    expect(
      (await w.call("github_add_issue_comment", { owner: "acme", repo: "app", issue_number: 1, body: "Hi" })).auth,
    ).toStartWith("Bearer ghs_app_");
  });
});

describe("what agents write on GitHub is signed (ADR 0153)", () => {
  test("bodies end with one line naming the agent and the person; an edit replaces the old one", async () => {
    const w = await world({ account: true });
    const line = `${SIGNATURE_MARK}\n<sub>Dev, agente de ana no agentes.chat</sub>`;
    const first = await w.call("github_add_issue_comment", {
      owner: "acme",
      repo: "app",
      issue_number: 1,
      body: "Fixed.",
    });
    expect(first.args?.body).toBe(`Fixed.\n\n${line}`);
    // Signed whichever token: the account's too.
    const other = await w.call("github_add_issue_comment", { owner: "other", repo: "x", issue_number: 1, body: "Ok" });
    expect(other.args?.body).toBe(`Ok\n\n${line}`);
    const edit = await w.call("github_update_issue_comment", {
      owner: "acme",
      repo: "app",
      comment_id: 9,
      body: `Fixed, and tested.\n\n${line}`,
    });
    expect(edit.args?.body).toBe(`Fixed, and tested.\n\n${line}`);
    // Only where a body is given; a pull request always gets one.
    const titled = await w.call("github_issue_write", { owner: "acme", repo: "app", method: "update", title: "New" });
    expect(titled.args).not.toHaveProperty("body");
    const pr = await w.call("github_create_pull_request", {
      owner: "acme",
      repo: "app",
      title: "T",
      head: "a",
      base: "main",
    });
    expect(pr.args?.body).toBe(line);
  });

  test("API commits credit the person when they linked GitHub to sign in", async () => {
    const w = await world({ account: true });
    const files = [{ path: "a.txt", content: "x" }];
    const plain = await w.call("github_push_files", { owner: "acme", repo: "app", branch: "b", files, message: "Fix" });
    expect(plain.args?.message).toBe("Fix");
    await f.db.insert(schema.accounts).values({
      id: crypto.randomUUID(),
      accountId: "583231",
      providerId: "github",
      userId: f.owner.id,
    });
    const credited = await w.call("github_push_files", {
      owner: "acme",
      repo: "app",
      branch: "b",
      files,
      message: "Fix login\n\nSigned-off-by: Dev <dev@example.com>",
    });
    expect(credited.args?.message).toBe(
      "Fix login\n\nSigned-off-by: Dev <dev@example.com>\nCo-authored-by: ana <583231+ana-gh@users.noreply.github.com>",
    );
  });
});
