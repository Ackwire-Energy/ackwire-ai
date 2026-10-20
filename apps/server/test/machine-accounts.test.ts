import { afterEach, expect, test } from "bun:test";
import {
  accountCodeAad,
  generateSecretKeyPair,
  MACHINE_PROTOCOL_VERSION,
  openSecret,
  type RunnerAccountInfo,
  type ServerFrame,
  sealSecret,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const OLD_ACCOUNT = "0193dddd-0000-4000-8000-000000000001";

interface Account {
  id: string;
  kind: string;
  label: string;
  email: string | null;
  plan: string | null;
  status: string;
  usedBy: string[];
}

/** A runner that signs Claude Code in like the real one would: a key per sign-in, the code opened with the AAD. */
function fakeRunner() {
  const hub = t.engine.machineHub;
  const keys = new Map<string, string>();
  const codes = new Map<string, string>();
  const requests: Extract<ServerFrame, { type: "request" }>[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      requests.push(frame);
      setTimeout(async () => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op !== "account") return ok({});
        if (frame.action === "begin") {
          const pair = await generateSecretKeyPair();
          keys.set(frame.loginId, pair.privateKey);
          return ok({ url: "https://claude.ai/oauth/authorize?code=true", publicKey: pair.publicKey });
        }
        if (frame.action === "code") {
          codes.set(frame.loginId, await openSecret(keys.get(frame.loginId) ?? "", frame.box, frame.aad));
          return ok({});
        }
        if (frame.action === "status") {
          return codes.has(frame.loginId)
            ? ok({
                state: "done",
                account: { id: frame.loginId, kind: "claude_code", loggedIn: true, email: "ana@example.com", plan: "max" },
              })
            : ok({ state: "waiting" });
        }
        return ok({});
      }, 1);
    },
    close() {},
  });
  return {
    codes,
    requests,
    hello: (token: string, accounts: RunnerAccountInfo[] = []) =>
      hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true, accounts })),
  };
}

async function workspace() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const admin = browser(t);
  await signUp(admin, "bia@example.com");
  const { url } = (await (
    await api("/invitations", { json: { email: "bia@example.com", role: "admin" } })
  ).json()) as { url: string };
  await admin(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const asAdmin = (path: string, init?: Parameters<typeof admin>[1]) =>
    admin(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, api, asAdmin };
}

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

test("accounts on a computer: the runner's list, signing in with a sealed code, rename, pick for an agent, remove", async () => {
  const { api, asAdmin, agentId, orgId } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  const runner = fakeRunner();
  await runner.hello(mac.token, [{ id: OLD_ACCOUNT, kind: "codex", loggedIn: false }]);
  const base = `/machines/${mac.machineId}`;

  // The runner's accounts, as the owner and an admin see them.
  const listed = await api(`${base}/accounts`);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    accounts: [
      { id: OLD_ACCOUNT, kind: "codex", label: "Codex", email: null, plan: null, status: "signed_out", usedBy: [] },
    ],
    canManage: true,
    supported: true,
  });
  expect(((await (await asAdmin(`${base}/accounts`)).json()) as { canManage: boolean }).canManage).toBe(false);

  // Only the person who connected it signs in.
  const refused = await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(refused.status).toBe(403);
  expect(await code(refused)).toBe("account.not_owner");
  expect((await api(`${base}/account-logins`, { json: { kind: "gemini" } })).status).toBe(400);

  const begun = await api(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(begun.status).toBe(201);
  const login = (await begun.json()) as { loginId: string; url: string; publicKey: string; expiresAt: string };
  expect(login.url).toBe("https://claude.ai/oauth/authorize?code=true");
  const waiting = (await (await api(`${base}/account-logins/${login.loginId}`)).json()) as { state: string };
  expect(waiting.state).toBe("waiting");

  // The code goes sealed in the browser; the server only relays it.
  const box = await sealSecret(login.publicKey, "abc#123", accountCodeAad(login.loginId, orgId));
  const sent = await api(`${base}/account-logins/${login.loginId}/code`, { json: { box } });
  expect(sent.status).toBe(204);
  expect(runner.codes.get(login.loginId)).toBe("abc#123");
  const done = (await (await api(`${base}/account-logins/${login.loginId}`)).json()) as {
    state: string;
    account: Account;
  };
  expect(done).toMatchObject({
    state: "done",
    account: { id: login.loginId, kind: "claude_code", label: "Claude Max", plan: "max", status: "active" },
  });
  const stored = JSON.stringify(await t.db.select().from(schema.machineAccounts));
  expect(stored).not.toContain("abc#123");
  expect((await api(`${base}/account-logins/${login.loginId}`, { method: "DELETE" })).status).toBe(204);

  // Rename; the agent thinks with it, at high effort.
  const renamed = await api(`${base}/accounts/${login.loginId}`, { method: "PATCH", json: { label: "Trabalho" } });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as Account).label).toBe("Trabalho");
  expect((await api(`${base}/accounts/${login.loginId}`, { method: "PATCH", json: { label: "" } })).status).toBe(400);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  const brain = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", acceptPlanTerms: true, account: login.loginId, effort: "high" },
  });
  expect(brain.status).toBe(200);
  expect(await brain.json()).toMatchObject({
    account: login.loginId,
    effort: "high",
    canManageAccounts: true,
    accountsSupported: true,
  });
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { account: OLD_ACCOUNT } })).status).toBe(400);
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { effort: "turbo" } })).status).toBe(400);
  const locked = await asAdmin(`/agents/${agentId}/brain`, { method: "PUT", json: { account: null } });
  expect(locked.status).toBe(403);
  expect(await code(locked)).toBe("account.not_owner");

  // Remove: signed out on the computer, the agent back on the computer's own sign-in.
  expect((await asAdmin(`${base}/accounts/${login.loginId}`, { method: "DELETE" })).status).toBe(403);
  expect((await api(`${base}/accounts/${login.loginId}`, { method: "DELETE" })).status).toBe(204);
  expect(runner.requests.at(-1)).toMatchObject({
    op: "account",
    action: "remove",
    kind: "claude_code",
    accountId: login.loginId,
  });
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(agent?.brainAccountId).toBeNull();
  const after = (await (await api(`${base}/accounts`)).json()) as { accounts: Account[] };
  expect(after.accounts.map((a) => a.id)).toEqual([OLD_ACCOUNT]);
});

test("an offline computer can't start a sign-in; renaming still works", async () => {
  const { api, orgId } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  await t.db.insert(schema.machineAccounts).values({
    id: OLD_ACCOUNT,
    orgId,
    machineId: mac.machineId,
    kind: "claude_code",
    label: "Claude",
  });
  const base = `/machines/${mac.machineId}`;
  const offline = await api(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(offline.status).toBe(409);
  expect(await code(offline)).toBe("machine.offline");
  const renamed = await api(`${base}/accounts/${OLD_ACCOUNT}`, { method: "PATCH", json: { label: "Pessoal" } });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as Account).label).toBe("Pessoal");
});

test("the OpenAPI document lists the account routes", async () => {
  t = await createTestServer();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  for (const path of [
    "/app/organizations/{orgId}/machines/{machineId}/accounts",
    "/app/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
    "/app/organizations/{orgId}/machines/{machineId}/account-logins",
    "/app/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}",
    "/app/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}/code",
  ]) {
    expect(Object.keys(doc.paths)).toContain(path);
  }
});
