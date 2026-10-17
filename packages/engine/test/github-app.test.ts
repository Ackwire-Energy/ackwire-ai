import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  appTokenForRepo,
  completeGitHubAppInstall,
  createLocalKeyWrapper,
  createOrganization,
  type GitHubAppConfig,
  type GitHubAppInstallDeps,
  handleGitHubAppWebhook,
  listGitHubAppInstallations,
  removeGitHubAppInstallation,
  startGitHubAppInstall,
  validGitHubAppSignature,
} from "../src";
import { addMember, addUser, SECRET } from "./fixtures";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP: GitHubAppConfig = {
  appId: "123",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  slug: "agentes-chat",
  clientId: "Iv1.client",
  clientSecret: "client-secret",
  webhookSecret: "hook-secret",
};
const API = "https://api.github.test";
const WEB = "https://github.test";

/**
 * Fake GitHub: `repos` maps "owner/repo" → installation id; `visible` maps a
 * user token → installation ids that user can see; codes → user tokens.
 */
function fakeGitHub(state: { repos: Record<string, number>; visible: Record<string, number[]> }) {
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${WEB}/login/oauth/access_token`) {
      const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
      return code.startsWith("code-")
        ? Response.json({ access_token: `user-${code.slice(5)}` })
        : Response.json({ error: "bad_verification_code" });
    }
    const repo = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
    if (repo) {
      const id = state.repos[repo[1] as string];
      return id ? Response.json({ id }) : new Response("not found", { status: 404 });
    }
    const token = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (token) {
      return Response.json(
        { token: `ghs_${token[1]}_${calls.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 },
      );
    }
    if (url.startsWith(`${API}/user/installations`)) {
      const auth = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      const ids = state.visible[auth] ?? [];
      return Response.json({
        installations: ids.map((id) => ({
          id,
          account: { login: `acct${id}`, type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
        })),
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function world() {
  const t = await createTestDatabase();
  close = t.close;
  const db: Database = t.db;
  const ana = await addUser(db, "ana");
  const bia = await addUser(db, "bia");
  const { organization: orgA } = await createOrganization(db, ana.id, { name: "A" });
  const { organization: orgB } = await createOrganization(db, bia.id, { name: "B" });
  const gh = {
    repos: { "a/app": 1, "b/secret": 2 } as Record<string, number>,
    visible: {} as Record<string, number[]>,
  };
  const fake = fakeGitHub(gh);
  const deps: GitHubAppInstallDeps = {
    db,
    keyWrappers: [createLocalKeyWrapper(SECRET)],
    app: APP,
    http: { fetch: fake.fetch, apiUrl: API, webUrl: WEB },
  };
  /** Installs `installationId` for `org` as `user` (their GitHub user can see `visible`). */
  const install = async (user: { id: string }, orgId: string, installationId: number, visible = [installationId]) => {
    const { state, installUrl } = await startGitHubAppInstall(deps, user.id, orgId, { returnTo: "/conectores" });
    expect(installUrl).toBe(`${WEB}/apps/agentes-chat/installations/new?state=${encodeURIComponent(state)}`);
    gh.visible[`user-${user.id}`] = visible;
    return completeGitHubAppInstall(deps, user, { state, code: `code-${user.id}`, installationId });
  };
  return { db, ana, bia, orgA, orgB, gh, fake, deps, install };
}

const http = (w: Awaited<ReturnType<typeof world>>) => ({ fetch: w.fake.fetch, apiUrl: API });

describe("GitHub App installations are bound to one organization", () => {
  test("tokens only for the installation the organization installed", async () => {
    const w = await world();
    const done = await w.install(w.ana, w.orgA.id, 1);
    expect(done.returnTo).toBe("/conectores");
    expect(done.installation).toMatchObject({ orgId: w.orgA.id, installationId: 1, accountLogin: "acct1" });
    await w.install(w.bia, w.orgB.id, 2);

    const read = { contents: "read" } as const;
    expect(await appTokenForRepo(APP, http(w), { db: w.db, orgId: w.orgA.id }, "a", "app", read)).toStartWith("ghs_1_");
    // Org A asking for org B's private repository: B's installation, not A's → no token.
    expect(await appTokenForRepo(APP, http(w), { db: w.db, orgId: w.orgA.id }, "b", "secret", read)).toBeNull();
    expect(await appTokenForRepo(APP, http(w), { db: w.db, orgId: w.orgB.id }, "a", "app", read)).toBeNull();
    // Installed on GitHub but bound to nobody (installed outside our flow): no token for anyone.
    w.gh.repos["c/other"] = 3;
    expect(await appTokenForRepo(APP, http(w), { db: w.db, orgId: w.orgA.id }, "c", "other", read)).toBeNull();
    expect(w.fake.calls.filter((c) => c.includes("/access_tokens"))).toHaveLength(1);
  });

  test("a cached token stops when the binding goes away", async () => {
    const w = await world();
    const { installation } = await w.install(w.ana, w.orgA.id, 1);
    const tenant = { db: w.db, orgId: w.orgA.id };
    const perms = { contents: "write" } as const;
    expect(await appTokenForRepo(APP, http(w), tenant, "a", "app", perms)).not.toBeNull();
    await removeGitHubAppInstallation(w.db, w.ana.id, w.orgA.id, installation.id);
    expect(await appTokenForRepo(APP, http(w), tenant, "a", "app", perms)).toBeNull();
  });

  test("the installation must be visible to the person's GitHub account", async () => {
    const w = await world();
    // Ana tries to claim installation 2 (org B's GitHub) by its id: her GitHub user can't see it.
    await expect(w.install(w.ana, w.orgA.id, 2, [1])).rejects.toThrow("isn't visible");
    expect(await listGitHubAppInstallations(w.db, w.ana.id, w.orgA.id)).toHaveLength(0);
  });

  test("an installation bound to another organization is refused", async () => {
    const w = await world();
    await w.install(w.bia, w.orgB.id, 2);
    await expect(w.install(w.ana, w.orgA.id, 2)).rejects.toThrow("another organization");
    const [row] = await w.db
      .select()
      .from(schema.githubAppInstallations)
      .where(eq(schema.githubAppInstallations.installationId, 2));
    expect(row?.orgId).toBe(w.orgB.id);
  });

  test("state: unknown, someone else's, reused, or started by a non-admin", async () => {
    const w = await world();
    const code = `code-${w.ana.id}`;
    w.gh.visible[`user-${w.ana.id}`] = [1];
    await expect(completeGitHubAppInstall(w.deps, w.ana, { state: "forged", code, installationId: 1 })).rejects.toThrow(
      "invalid or expired",
    );

    const { state } = await startGitHubAppInstall(w.deps, w.ana.id, w.orgA.id);
    await expect(completeGitHubAppInstall(w.deps, w.bia, { state, code, installationId: 1 })).rejects.toThrow(
      "account that started it",
    );
    await completeGitHubAppInstall(w.deps, w.ana, { state, code, installationId: 1 });
    await expect(completeGitHubAppInstall(w.deps, w.ana, { state, code, installationId: 1 })).rejects.toThrow(
      "invalid or expired",
    );

    const member = await addMember(w.db, w.orgA.id, "member", "caio");
    await expect(startGitHubAppInstall(w.deps, member.id, w.orgA.id)).rejects.toThrow();
  });

  test("not configured: no install link", async () => {
    const w = await world();
    await expect(startGitHubAppInstall({ ...w.deps, app: null }, w.ana.id, w.orgA.id)).rejects.toThrow(
      "not configured",
    );
  });
});

describe("GitHub App webhook", () => {
  const sign = (body: string, secret = "hook-secret") =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  test("signature over the raw body", () => {
    const body = JSON.stringify({ action: "deleted" });
    expect(validGitHubAppSignature("hook-secret", body, sign(body))).toBe(true);
    expect(validGitHubAppSignature("hook-secret", body, sign(body, "other"))).toBe(false);
    expect(validGitHubAppSignature("hook-secret", `${body} `, sign(body))).toBe(false);
    expect(validGitHubAppSignature("hook-secret", body, null)).toBe(false);
  });

  test("suspend, unsuspend, repository changes and uninstall", async () => {
    const w = await world();
    await w.install(w.ana, w.orgA.id, 1);
    const tenant = { db: w.db, orgId: w.orgA.id };
    const read = { contents: "read" } as const;

    expect(await handleGitHubAppWebhook(w.db, "installation", { action: "suspend", installation: { id: 1 } })).toBe(
      "suspended",
    );
    expect(await appTokenForRepo(APP, http(w), tenant, "a", "app", read)).toBeNull();
    expect(await handleGitHubAppWebhook(w.db, "installation", { action: "unsuspend", installation: { id: 1 } })).toBe(
      "unsuspended",
    );
    expect(await appTokenForRepo(APP, http(w), tenant, "a", "app", read)).not.toBeNull();

    expect(
      await handleGitHubAppWebhook(w.db, "installation_repositories", {
        action: "added",
        installation: { id: 1, repository_selection: "all" },
      }),
    ).toBe("updated");
    const [row] = await listGitHubAppInstallations(w.db, w.ana.id, w.orgA.id);
    expect(row?.repositorySelection).toBe("all");

    // Not ours to bind: an installation made outside the flow stays ignored.
    expect(await handleGitHubAppWebhook(w.db, "installation", { action: "created", installation: { id: 9 } })).toBe(
      "ignored",
    );
    expect(await handleGitHubAppWebhook(w.db, "installation", { action: "deleted", installation: { id: 1 } })).toBe(
      "removed",
    );
    expect(await listGitHubAppInstallations(w.db, w.ana.id, w.orgA.id)).toHaveLength(0);
    expect(await appTokenForRepo(APP, http(w), tenant, "a", "app", read)).toBeNull();
  });
});
