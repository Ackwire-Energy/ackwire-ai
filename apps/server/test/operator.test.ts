import { afterAll, beforeAll, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { testConfig } from "@agenteschat/config";
import { desc, eq, schema, sql } from "@agenteschat/db";
import { setRestrictionNotices } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp, type OperatorDeps, serveOperatorApi } from "../src/operator/app";
import { type Browser, browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

const TOKEN = "operator-test-token-".padEnd(48, "x");
const BEARER = `Bearer ${TOKEN}`;

let t: TestServer;
let deps: OperatorDeps;
/** A request to the operator API with this `Authorization` header (null: none). */
let op: (path: string, authorization?: string | null) => Promise<Response>;
/** A PUT of JSON to the operator API. */
let put: (path: string, json: unknown) => Promise<Response>;
let acme: { orgId: string; ownerId: string; agentId: string; channelId: string };
let owner: Browser;

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN, ALLOW_SIGNUP: "true" } });
  deps = {
    db: t.db,
    config: t.config,
    version: "test",
    log: createLogger("error"),
    pubsub: t.adapters.pubsub,
    hub: t.engine.machineHub,
  };
  const app = createOperatorApp(deps, TOKEN);
  op = async (path, authorization = BEARER) =>
    app.request(`/api/operator/v1${path}`, { headers: authorization === null ? {} : { authorization } });
  put = async (path, json) =>
    app.request(`/api/operator/v1${path}`, {
      method: "PUT",
      headers: { authorization: BEARER, "content-type": "application/json" },
      body: JSON.stringify(json),
    });

  owner = browser(t);
  await signUp(owner, "owner@acme.test");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  if (!user) throw new Error("no user");
  acme = { orgId, ownerId: user.id, agentId, channelId };

  // Same millisecond, different microseconds; and two at the same instant: paging must keep them all.
  await t.db.insert(schema.organizations).values([
    { name: "Paging A", createdAt: sql`'2026-01-01T00:00:00Z'::timestamptz` },
    { name: "Paging B", createdAt: sql`'2026-01-02T00:00:00.123456Z'::timestamptz` },
    { name: "Paging C", createdAt: sql`'2026-01-02T00:00:00.123789Z'::timestamptz` },
    { name: "Paging D", createdAt: sql`'2026-01-03T00:00:00Z'::timestamptz` },
    { name: "Paging E", createdAt: sql`'2026-01-03T00:00:00Z'::timestamptz` },
  ]);
});

afterAll(() => t.close());

async function body<T = Record<string, unknown>>(res: Response) {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

type Page = {
  orgs: { id: string; name: string; createdAt: string; standing: string; members: number; agents: number }[];
  next: string | null;
};

test("without OPERATOR_API_TOKEN nothing listens; the public listener never serves the operator API", async () => {
  expect(serveOperatorApi({ ...deps, config: testConfig() })).toBeNull();

  const server = serveOperatorApi({ ...deps, config: testConfig({ OPERATOR_API_TOKEN: TOKEN, HOST: "127.0.0.1" }) }, 0);
  if (!server) throw new Error("no operator listener");
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/api/operator/v1/health`, { headers: { authorization: BEARER } });
    expect(await health.json()).toMatchObject({ ok: true, version: "test", botCheck: { state: "off" } });
    // Only the operator API there, not the app.
    expect((await fetch(`${base}/api/health`, { headers: { authorization: BEARER } })).status).toBe(404);
  } finally {
    await server.stop(true);
  }

  // This server has the token set too.
  for (const path of ["/api/operator/v1/health", "/api/operator/v1/orgs", "/api/operator/health"]) {
    expect((await t.app.request(path, { headers: { authorization: BEARER } })).status).toBe(404);
  }
});

test("401 without the right bearer token, on every path under the prefix", async () => {
  for (const [path, authorization] of [
    ["/health", null],
    ["/health", "Bearer wrong"],
    ["/health", `Bearer ${TOKEN.slice(0, -1)}y`],
    ["/health", `Basic ${TOKEN}`],
    ["/health", TOKEN],
    ["/orgs", `${BEARER}x`],
    ["/openapi.json", null],
    ["/nope", null],
  ] as const) {
    const res = await op(path, authorization);
    expect({ path, authorization, status: res.status }).toEqual({ path, authorization, status: 401 });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  }
  expect((await op("/nope")).status).toBe(404);
});

test("health, with the bot check: off without its keys, else its state, since when, the networks it refused and the tokens it passed", async () => {
  const off = await body<{ ok: boolean; version: string; botCheck: Record<string, unknown> & { since: string } }>(
    await op("/health"),
  );
  expect(off).toEqual({
    ok: true,
    version: "test",
    botCheck: { state: "off", since: off.botCheck.since, blocked: 0, passed: 0, testing: false },
  });
  expect(off.botCheck.since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  const since = new Date("2026-10-27T12:00:00.000Z");
  const humanCheck = {
    siteKey: "1x00000000000000000000AA",
    verify: async () => null,
    probe: async () => "unreachable" as const,
    status: () => ({ state: "unreachable" as const, since, blocked: 21, passed: 3, testing: false }),
  };
  const app = createOperatorApp({ ...deps, humanCheck }, TOKEN);
  const res = await app.request("/api/operator/v1/health", { headers: { authorization: BEARER } });
  expect(await body(res)).toEqual({
    ok: true,
    version: "test",
    botCheck: { state: "unreachable", since: "2026-10-27T12:00:00.000Z", blocked: 21, passed: 3, testing: false },
  });
});

test("org search: by id, part of the name or of a member's email, any case; no wildcards", async () => {
  const names = async (q: string) =>
    (await body<Page>(await op(`/orgs?q=${encodeURIComponent(q)}`))).orgs.map((o) => o.name).sort();
  expect(await names("ACME")).toEqual(["Acme"]);
  expect(await names("OWNER@")).toEqual(["Acme"]);
  expect(await names(acme.orgId)).toEqual(["Acme"]);
  expect(await names("paging")).toEqual(["Paging A", "Paging B", "Paging C", "Paging D", "Paging E"]);
  expect(await names("%")).toEqual([]);
  expect(await names("_")).toEqual([]);

  const { orgs } = await body<Page>(await op(`/orgs?q=${acme.orgId}`));
  expect(orgs).toEqual([
    { id: acme.orgId, name: "Acme", createdAt: expect.any(String), standing: "active", members: 1, agents: 1 },
  ]);

  const after = encodeURIComponent("2026-01-02T12:00:00Z");
  const recent = await body<Page>(await op(`/orgs?q=paging&createdAfter=${after}`));
  expect(recent.orgs.map((o) => o.name).sort()).toEqual(["Paging D", "Paging E"]);
});

test("org paging: newest first, every workspace exactly once, at any page size", async () => {
  const all = await body<Page>(await op("/orgs?limit=200"));
  expect(all.next).toBeNull();
  const times = all.orgs.map((o) => o.createdAt);
  expect(times).toEqual([...times].sort().reverse());
  const ids = (await t.db.select({ id: schema.organizations.id }).from(schema.organizations)).map((r) => r.id);
  expect(all.orgs.map((o) => o.id).sort()).toEqual(ids.sort());

  for (const limit of [1, 2, 4]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await body<Page>(await op(`/orgs?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`));
      expect(page.orgs.length).toBeLessThanOrEqual(limit);
      seen.push(...page.orgs.map((o) => o.id));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(all.orgs.map((o) => o.id));
  }

  for (const query of ["limit=0", "limit=201", "cursor=nope", "createdAfter=yesterday"]) {
    expect({ query, status: (await op(`/orgs?${query}`)).status }).toEqual({ query, status: 400 });
  }
  const bad = (await (await op("/orgs?cursor=nope")).json()) as { error: { code: string } };
  expect(bad.error.code).toBe("invalid_cursor");
});

test("org detail: owners and admins, and counts of what is in it", async () => {
  const { orgId } = acme;
  await t.db.insert(schema.users).values({ id: "admin-user", name: "Ada", email: "ada@acme.test" });
  await t.db.insert(schema.organizationMembers).values({ orgId, userId: "admin-user", role: "admin" });
  await t.db.insert(schema.agents).values({ orgId, name: "Old", handle: "old", model: "x", archivedAt: new Date() });
  await t.db.insert(schema.channels).values({ orgId, name: "dm-1", kind: "dm" });
  const day = 86_400_000;
  await t.db.insert(schema.organizationInvitations).values([
    { orgId, email: "new@acme.test", role: "member", tokenHash: "h1", expiresAt: new Date(Date.now() + day) },
    { orgId, email: "late@acme.test", role: "member", tokenHash: "h2", expiresAt: new Date(Date.now() - day) },
  ]);
  await t.db.insert(schema.machines).values([
    { orgId, name: "Mac", tokenHash: "machine-token-hash" },
    { orgId, name: "Gone", deletedAt: new Date() },
  ]);

  const org = await body(await op(`/orgs/${orgId}`));
  expect(org).toEqual({
    id: orgId,
    name: "Acme",
    createdAt: expect.any(String),
    standing: { state: "active", reason: null, note: null, notice: "shown", changedAt: null },
    admins: [
      {
        userId: acme.ownerId,
        email: "owner@acme.test",
        name: "owner",
        role: "owner",
        createdAt: expect.any(String),
        lastSeenAt: null,
      },
      {
        userId: "admin-user",
        email: "ada@acme.test",
        name: "Ada",
        role: "admin",
        createdAt: expect.any(String),
        lastSeenAt: null,
      },
    ],
    counts: { members: 2, agents: 1, channels: 1, machines: 1, invitations: 1 },
  });

  expect((await op("/orgs/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b")).status).toBe(404);
  expect((await op("/orgs/not-a-uuid")).status).toBe(400);
});

test("user detail: workspaces and at most the 10 newest sessions", async () => {
  await t.db.insert(schema.sessions).values(
    Array.from({ length: 11 }, (_, i) => ({
      id: `s-${i}`,
      token: `session-token-${i}`,
      userId: acme.ownerId,
      ipAddress: `198.51.100.${i}`,
      userAgent: `Agent ${i}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    })),
  );

  const user = await body<{ sessions: { ip: string | null; userAgent: string | null; createdAt: string }[] }>(
    await op(`/users/${acme.ownerId}`),
  );
  expect(user).toMatchObject({ id: acme.ownerId, email: "owner@acme.test", name: "owner", emailVerified: false });
  expect(user).toMatchObject({
    orgs: [{ orgId: acme.orgId, name: "Acme", role: "owner", joinedAt: expect.any(String), lastSeenAt: null }],
  });
  expect(user.sessions).toHaveLength(10);
  const times = user.sessions.map((s) => s.createdAt);
  expect(times).toEqual([...times].sort().reverse());
  // The sign-up's own session is the newest; the two oldest inserted ones fall off.
  expect(user.sessions[1]).toEqual({
    ip: "198.51.100.10",
    userAgent: "Agent 10",
    createdAt: "2026-01-01T00:10:00.000Z",
  });
  expect(user.sessions.at(-1)?.ip).toBe("198.51.100.2");

  expect((await op("/users/nobody")).status).toBe(404);
});

test("standing: hold, suspend and restore a workspace; the app API enforces it", async () => {
  const { orgId } = acme;
  const app = (path: string, init?: Parameters<Browser>[1]) => owner(`/api/app/organizations/${orgId}${path}`, init);
  const invite = () => app("/invitations", { json: { email: "new-hire@acme.test", role: "member" } });
  const error = async (res: Response) => ((await res.json()) as { error: Record<string, unknown> }).error;
  // What its people are told (the banner, the suspended screen): never the note, the reason only when shown.
  const told = async () =>
    (
      await body<{ organizations: { id: string; standing?: unknown }[] }>(await owner("/api/app/me"))
    ).organizations.find((o) => o.id === orgId)?.standing;
  expect(await told()).toEqual({ state: "active", reason: null });

  for (const bad of [
    { state: "paused", reason: "x", notice: "shown" },
    { state: "hold", reason: "", notice: "shown" },
    { state: "hold", reason: "x".repeat(65), notice: "shown" },
    { state: "hold", reason: "x", notice: "loud" },
    { state: "hold", reason: "x" },
    { state: "hold", reason: "x", notice: "shown", note: "x".repeat(2001) },
  ]) {
    expect({ bad, status: (await put(`/orgs/${orgId}/standing`, bad)).status }).toEqual({ bad, status: 400 });
  }
  const unknown = await put("/orgs/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/standing", {
    state: "hold",
    reason: "x",
    notice: "shown",
  });
  expect(unknown.status).toBe(404);

  const held = await body(
    await put(`/orgs/${orgId}/standing`, { state: "hold", reason: "Unpaid invoice", note: "card", notice: "shown" }),
  );
  expect(held).toEqual({
    state: "hold",
    reason: "Unpaid invoice",
    note: "card",
    notice: "shown",
    changedAt: expect.any(String),
  });
  expect((await body<{ standing: unknown }>(await op(`/orgs/${orgId}`))).standing).toEqual(held);
  const onHold = await body<Page>(await op("/orgs?standing=hold"));
  expect(onHold.orgs.map((o) => [o.name, o.standing])).toEqual([["Acme", "hold"]]);
  expect(await told()).toEqual({ state: "hold", reason: "Unpaid invoice" });
  // People still use it; nothing new goes out.
  expect((await app("/members")).status).toBe(200);
  const refused = await invite();
  expect(refused.status).toBe(403);
  expect(await error(refused)).toEqual({
    code: "org.paused",
    message: "This workspace is on hold: Unpaid invoice",
    params: { reason: "Unpaid invoice" },
  });

  await body(await put(`/orgs/${orgId}/standing`, { state: "suspended", reason: "Phishing", notice: "silent" }));
  // Silent: its people learn it is closed, not why; `/me` still lists it, for its screen.
  expect(await told()).toEqual({ state: "suspended", reason: null });
  const locked = await app("/members");
  expect(locked.status).toBe(403);
  expect(await error(locked)).toEqual({ code: "org.suspended", message: "This workspace is unavailable for now." });

  const restored = await body(
    await put(`/orgs/${orgId}/standing`, { state: "active", reason: "Cleared", notice: "shown" }),
  );
  expect(restored).toMatchObject({ state: "active", reason: "Cleared", note: null });
  expect((await app("/members")).status).toBe(200);
  expect((await invite()).status).toBe(201);
});

test("agent hold: that agent stops, the workspace works; let go, it answers", async () => {
  const { orgId, agentId, channelId } = acme;
  const hold = (json: unknown, id = agentId, org = orgId) => put(`/orgs/${org}/agents/${id}/hold`, json);
  const ask = async (text: string) => {
    expect(
      (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: text } })).status,
    ).toBe(201);
    await t.drain();
    const [run] = await t.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agentId, agentId))
      .orderBy(desc(schema.agentRuns.createdAt))
      .limit(1);
    return run;
  };

  for (const bad of [{}, { held: "yes" }, { held: true, reason: "" }, { held: true, reason: "x".repeat(65) }]) {
    expect({ bad, status: (await hold(bad)).status }).toEqual({ bad, status: 400 });
  }
  expect((await hold({ held: true }, "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b")).status).toBe(404);
  const [other] = await t.db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.name, "Paging A"));
  expect((await hold({ held: true }, agentId, other?.id)).status).toBe(404);

  expect(await body(await hold({ held: true, reason: "Spam" }))).toEqual({
    held: true,
    heldAt: expect.any(String),
    reason: "Spam",
  });
  const calls = t.provider.calls.length;
  expect(await ask("@dev status?")).toMatchObject({ status: "failed", error: "This agent is paused for now." });
  expect(t.provider.calls).toHaveLength(calls);
  // People still use the workspace.
  expect((await owner(`/api/app/organizations/${orgId}/members`)).status).toBe(200);

  expect(await body(await hold({ held: false }))).toEqual({ held: false, heldAt: null, reason: null });
  expect(await ask("@dev and now?")).toMatchObject({ status: "done" });
  expect(t.provider.calls).toHaveLength(calls + 1);
});

test("user block: refused at once even with a cached session, signed out, no sign-in; unblocked, back in", async () => {
  const bia = browser(t);
  await signUp(bia, "bia@acme.test");
  const [row] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "bia@acme.test"));
  if (!row) throw new Error("no user");
  const biaId = row.id;
  await t.db.insert(schema.organizationMembers).values({ orgId: acme.orgId, userId: biaId, role: "member" });
  const members = () => bia(`/api/app/organizations/${acme.orgId}/members`);
  const signIn = () =>
    bia("/api/auth/sign-in/email", { json: { email: "bia@acme.test", password: "correct horse battery" } });
  expect((await members()).status).toBe(200);
  const revoked: unknown[] = [];
  t.adapters.pubsub.subscribe(orgTopic(acme.orgId), (e) => {
    if (e.type === "membership.revoked") revoked.push(e);
  });

  for (const bad of [{}, { blocked: "yes" }, { blocked: true, reason: "x".repeat(65) }]) {
    expect({ bad, status: (await put(`/users/${biaId}/block`, bad)).status }).toEqual({ bad, status: 400 });
  }
  expect((await put("/users/nobody/block", { blocked: true })).status).toBe(404);

  const blocked = await body(await put(`/users/${biaId}/block`, { blocked: true, reason: "Phishing" }));
  expect(blocked).toEqual({ blocked: true, blockedAt: expect.any(String), reason: "Phishing", sessionsRevoked: 1 });
  expect(revoked).toEqual([{ type: "membership.revoked", orgId: acme.orgId, userId: biaId }]);
  // The browser still holds the session in its signed cookie cache for minutes: refused all the same.
  expect(bia.cookie()).toContain("session_data");
  expect((await members()).status).toBe(403);
  expect(await (await bia("/api/app/me")).json()).toMatchObject({ organizations: [] });
  const refused = await signIn();
  expect(refused.status).toBe(403);
  const said = await refused.json();
  expect(said).toMatchObject({ code: "ACCOUNT_BLOCKED" });
  // A self-hosted server says nothing more.
  expect(said).not.toHaveProperty("kind");
  expect(await body(await op(`/users/${biaId}`))).toMatchObject({
    blockedAt: blocked.blockedAt,
    blockedReason: "Phishing",
    sessions: [],
  });

  expect(await body(await put(`/users/${biaId}/block`, { blocked: false }))).toEqual({
    blocked: false,
    blockedAt: null,
    reason: null,
    sessionsRevoked: 0,
  });
  expect((await signIn()).status).toBe(200);
  expect((await members()).status).toBe(200);
  expect(await body(await op(`/users/${biaId}`))).toMatchObject({ blockedAt: null, blockedReason: null });
});

test("on agentes.chat Cloud a blocked sign-in says the block's kind, never its reason", async () => {
  setRestrictionNotices("https://agentes.chat");
  try {
    const cid = browser(t);
    await signUp(cid, "cid@acme.test");
    const [row] = await t.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "cid@acme.test"));
    if (!row) throw new Error("no user");
    await put(`/users/${row.id}/block`, { blocked: true, reason: "abuse.resignup" });
    const refused = await cid("/api/auth/sign-in/email", {
      json: { email: "cid@acme.test", password: "correct horse battery" },
    });
    expect(refused.status).toBe(403);
    const said = await refused.json();
    expect(said).toMatchObject({ code: "ACCOUNT_BLOCKED", kind: "abuse", cloud: true });
    expect(JSON.stringify(said)).not.toContain("resignup");
  } finally {
    setRestrictionNotices("http://localhost:3000");
  }
});

test("external provisioning: requests, progress, the workspace's computer and its single-use code", async () => {
  const { orgId } = acme;
  const call = (method: string, path: string, json?: unknown) =>
    createOperatorApp(deps, TOKEN).request(`/api/operator/v1${path}`, {
      method,
      headers: { authorization: BEARER, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const external = createOperatorApp({ ...deps, config: { ...deps.config, MACHINE_PROVISIONING: "external" } }, TOKEN);
  type Requests = { requests: { orgId: string; [key: string]: unknown }[]; next: string | null };

  // This server provisions nothing; one that does lists every active workspace without a ready computer.
  expect(await body(await op("/machine-requests"))).toEqual({ requests: [], next: null });
  const listed = await body<Requests>(
    await external.request("/api/operator/v1/machine-requests?limit=200", { headers: { authorization: BEARER } }),
  );
  expect(listed.requests.find((r) => r.orgId === orgId)).toEqual({
    orgId,
    orgName: "Acme",
    createdAt: expect.any(String),
    owner: { userId: acme.ownerId, email: "owner@acme.test" },
    provisioning: null,
  });

  for (const bad of [
    { state: "ready" },
    { state: "preparing", step: "flying" },
    { state: "waiting", reason: "bored" },
    { state: "problem", etaSeconds: -1 },
    { state: "preparing", specs: { cpus: 0, memoryGb: 8, diskGb: 75 } },
    { state: "preparing", expectedReadyAt: "in ten minutes" },
    { state: "preparing", expectedReadyAt: new Date(Date.now() + 8 * 86_400_000).toISOString() },
    { state: "preparing", step: "installing", stage: "a".repeat(65) },
  ]) {
    expect({ bad, status: (await put(`/orgs/${orgId}/provisioning`, bad)).status }).toEqual({ bad, status: 400 });
  }
  // A stage of any shape is kept as said rather than the whole report refused: the apps read one they don't know as
  // its step.
  const odd = { state: "preparing", step: "installing", stage: "Re-wiping" };
  expect((await put(`/orgs/${orgId}/provisioning`, odd)).status).toBe(204);
  const oddly = await body<Requests>(
    await external.request("/api/operator/v1/machine-requests?limit=200", { headers: { authorization: BEARER } }),
  );
  expect(oddly.requests.find((r) => r.orgId === orgId)?.provisioning).toMatchObject({ stage: "Re-wiping" });
  expect((await put("/orgs/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/provisioning", { state: "problem" })).status).toBe(404);
  const specs = { cpus: 4, memoryGb: 8, diskGb: 75 };
  // A time already past is normal: any moment now.
  const readyAt = new Date(Date.now() - 5000).toISOString();
  expect(
    (
      await put(`/orgs/${orgId}/provisioning`, {
        state: "preparing",
        step: "connecting",
        stage: "connecting",
        specs,
        expectedReadyAt: readyAt,
      })
    ).status,
  ).toBe(204);
  const progress = await body<Requests>(
    await external.request("/api/operator/v1/machine-requests?limit=200", { headers: { authorization: BEARER } }),
  );
  expect(progress.requests.find((r) => r.orgId === orgId)?.provisioning).toEqual({
    state: "preparing",
    step: "connecting",
    stage: "connecting",
    reason: null,
    since: expect.any(String),
    requestedAt: listed.requests.find((r) => r.orgId === orgId)?.createdAt,
    expectedReadyAt: readyAt,
    specs,
  });
  // An older client's words still go through.
  expect((await put(`/orgs/${orgId}/provisioning`, { state: "waiting", reason: "approval" })).status).toBe(204);
  expect((await put(`/orgs/${orgId}/provisioning`, { state: "preparing", etaSeconds: 600 })).status).toBe(204);
  expect((await put(`/orgs/${orgId}/provisioning`, { state: "preparing", step: "connecting", specs })).status).toBe(
    204,
  );
  expect(await body(await owner(`/api/app/organizations/${orgId}/computer-setup`))).toEqual({
    mode: "pair",
    state: null,
    step: null,
    stage: null,
    reason: null,
    since: null,
    requestedAt: null,
    expectedReadyAt: null,
    specs: null,
    secondsLeft: null,
    secondsWaited: null,
    notifyByEmail: false,
    machineId: null,
  });

  type Issued = { machineId: string; enrollCode: string; expiresAt: string };
  const issued = await body<Issued>(await call("POST", `/orgs/${orgId}/machines`, { name: "Computador da Acme" }));
  const again = await body<Issued>(await call("POST", `/orgs/${orgId}/machines`, {}));
  expect(again.machineId).toBe(issued.machineId);
  expect((await call("POST", "/orgs/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/machines", {})).status).toBe(404);
  // The computer redeems it on the public address like any confirmed code, once.
  const redeem = (deviceCode: string) =>
    t.app.request("/api/machines/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
  expect((await redeem(issued.enrollCode)).status).toBe(400);
  expect(await body(await redeem(again.enrollCode))).toMatchObject({
    machineId: issued.machineId,
    name: "Computador da Acme",
    org: { id: orgId, name: "Acme" },
  });
  expect((await redeem(again.enrollCode)).status).toBe(400);

  const machines = await call("GET", `/orgs/${orgId}/machines`);
  const text = await machines.text();
  expect((JSON.parse(text) as { machines: unknown[] }).machines).toContainEqual({
    id: issued.machineId,
    kind: "managed",
    managed: true,
    name: "Computador da Acme",
    online: false,
    lastSeenAt: null,
    runnerVersion: "",
    protocol: 1,
  });
  expect(text).not.toMatch(/token|hash/i);

  const refused = await owner(`/api/app/organizations/${orgId}/machines/${issued.machineId}`, { method: "DELETE" });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("machine.managed");

  expect((await call("DELETE", `/orgs/${orgId}/machines/${issued.machineId}`)).status).toBe(204);
  expect((await call("DELETE", `/orgs/${orgId}/machines/${issued.machineId}`)).status).toBe(404);
  const after = await body<{ machines: { id: string }[] }>(await call("GET", `/orgs/${orgId}/machines`));
  expect(after.machines.map((m) => m.id)).not.toContain(issued.machineId);
  expect((await call("GET", "/orgs/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/machines")).status).toBe(404);

  // Held (ended, say), it waits for no computer: a report for it is refused until it is active again.
  expect((await put(`/orgs/${orgId}/standing`, { state: "hold", reason: "ended", notice: "shown" })).status).toBe(200);
  const late = await put(`/orgs/${orgId}/provisioning`, { state: "waiting", reason: "capacity" });
  expect({ status: late.status, code: ((await late.json()) as { error: { code: string } }).error.code }).toEqual({
    status: 403,
    code: "org.paused",
  });
  expect((await put(`/orgs/${orgId}/standing`, { state: "active", reason: "back", notice: "shown" })).status).toBe(200);
  expect((await put(`/orgs/${orgId}/provisioning`, { state: "waiting", reason: "capacity" })).status).toBe(204);
});

test("early access: every route needs the token, answers in its shape, and refuses with its codes", async () => {
  const app = createOperatorApp({ ...deps, emails: true }, TOKEN);
  const call = (method: string, path: string, json?: unknown, authorization: string | null = BEARER) =>
    app.request(`/api/operator/v1${path}`, {
      method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  const unknown = crypto.randomUUID();
  for (const [method, path] of [
    ["GET", "/signup"],
    ["PUT", "/signup"],
    ["GET", "/waitlist"],
    ["GET", "/waitlist/next"],
    ["POST", "/waitlist/import"],
    ["POST", "/early-access/invitations"],
    ["GET", "/early-access/invitations"],
    ["POST", `/early-access/invitations/${unknown}/resend`],
    ["POST", `/early-access/invitations/${unknown}/revoke`],
  ] as const) {
    const res = await call(method, path, method === "GET" ? undefined : {}, null);
    expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
  }

  // This server has ALLOW_SIGNUP=true.
  expect(await body(await call("GET", "/signup"))).toEqual({
    mode: "invite",
    forcedOpen: true,
    changedAt: null,
    emails: true,
  });
  expect(await code(await call("PUT", "/signup", { mode: "closed" }))).toBe("invalid_request");

  expect(
    await body(
      await call("POST", "/waitlist/import", {
        entries: [
          { email: "wl-one@acme.test", locale: "en", joinedAt: "2026-01-01T00:00:00Z" },
          { email: "not an address" },
          { email: "wl-two@acme.test" },
        ],
      }),
    ),
  ).toEqual({ added: 2, confirmed: 0, unchanged: 0, invalid: [1] });
  for (const entries of [[], Array.from({ length: 5001 }, (_, i) => ({ email: `p${i}@acme.test` }))]) {
    expect(await code(await call("POST", "/waitlist/import", { entries }))).toBe("invalid_request");
  }
  expect(await body(await call("GET", "/waitlist"))).toEqual({
    unconfirmed: 0,
    confirmed: 2,
    waiting: 2,
    invited: 0,
    signedUp: 0,
    workspaceCreated: 0,
  });
  expect(await body(await call("GET", "/waitlist/next?limit=1"))).toEqual({
    entries: [{ email: "wl-one@acme.test", locale: "en", joinedAt: "2026-01-01T00:00:00.000Z" }],
  });
  for (const limit of [0, 201]) {
    expect((await call("GET", `/waitlist/next?limit=${limit}`)).status).toBe(400);
  }

  const invited = await body<{ results: { email: string; outcome: string; invitationId?: string }[] }>(
    await call("POST", "/early-access/invitations", { emails: ["wl-one@acme.test", "owner@acme.test", "x"] }),
  );
  expect(invited.results).toEqual([
    { email: "wl-one@acme.test", outcome: "invited", invitationId: expect.any(String) },
    { email: "owner@acme.test", outcome: "has_account" },
    { email: "x", outcome: "invalid_email" },
  ]);
  const id = invited.results[0]?.invitationId ?? "";
  for (const emails of [[], Array(201).fill("a@acme.test")]) {
    expect(await code(await call("POST", "/early-access/invitations", { emails }))).toBe("invalid_request");
  }

  const page = await body<{ invitations: Record<string, unknown>[]; counts: unknown; next: unknown }>(
    await call("GET", "/early-access/invitations?limit=1"),
  );
  expect(page).toEqual({
    invitations: [
      {
        id,
        email: "wl-one@acme.test",
        locale: "en",
        state: "sent",
        createdAt: expect.any(String),
        sentAt: expect.any(String),
        sends: 1,
        expiresAt: expect.any(String),
        revokedAt: null,
        usedAt: null,
        userId: null,
        workspaceCreatedAt: null,
        workspaceId: null,
      },
    ],
    counts: { sent: 1, expired: 0, signedUp: 0, workspaceCreated: 0, revoked: 0 },
    next: null,
  });
  for (const query of ["state=gone", "limit=0", "limit=201", "cursor=nope"]) {
    expect({ query, status: (await call("GET", `/early-access/invitations?${query}`)).status }).toEqual({
      query,
      status: 400,
    });
  }

  // Within 2 minutes nothing goes out again.
  expect(await body(await call("POST", `/early-access/invitations/${id}/resend`))).toMatchObject({
    sent: false,
    invitation: { id, sends: 1 },
  });
  for (const action of ["resend", "revoke"]) {
    expect(await code(await call("POST", `/early-access/invitations/${unknown}/${action}`))).toBe("not_found");
    expect((await call("POST", `/early-access/invitations/nope/${action}`)).status).toBe(400);
  }

  // Its link makes an account, whose first workspace is recorded on it even here, where sign-up is open.
  const [queued] = await t.db
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(sql`${schema.outbox.payload}->>'key' like ${`early-access:${id}:%`}`);
  const link = (queued?.payload as { template?: { url?: string } } | undefined)?.template?.url ?? "";
  const access = new URL(link).searchParams.get("access");
  const ana = browser(t);
  const signedUp = await ana("/api/auth/sign-up/email", {
    json: { email: "wl-one@acme.test", password: "correct horse battery", name: "Ana" },
    headers: { "x-early-access": access ?? "" },
  });
  expect(signedUp.status).toBe(200);
  expect(await code(await call("POST", `/early-access/invitations/${id}/resend`))).toBe("early_access.used");
  expect((await ana("/api/app/organizations", { json: { name: "Ana" } })).status).toBe(201);
  expect(await code(await call("POST", `/early-access/invitations/${id}/revoke`))).toBe(
    "early_access.workspace_created",
  );
  expect(await body(await call("GET", "/waitlist"))).toMatchObject({ invited: 1, signedUp: 1, workspaceCreated: 1 });

  const other = await body<{ results: { invitationId?: string }[] }>(
    await call("POST", "/early-access/invitations", { emails: ["wl-two@acme.test"], resend: false }),
  );
  const otherId = other.results[0]?.invitationId ?? "";
  await signUp(browser(t), "wl-two@acme.test");
  expect(await code(await call("POST", `/early-access/invitations/${otherId}/resend`))).toBe(
    "early_access.has_account",
  );
  const revoked = await body<{ invitation: { state: string; revokedAt: string } }>(
    await call("POST", `/early-access/invitations/${otherId}/revoke`),
  );
  expect(revoked.invitation.state).toBe("revoked");
  expect(await body(await call("POST", `/early-access/invitations/${otherId}/revoke`))).toEqual(revoked);

  const quiet = createOperatorApp({ ...deps, emails: false }, TOKEN);
  const refused = await quiet.request(`/api/operator/v1/early-access/invitations/${otherId}/resend`, {
    method: "POST",
    headers: { authorization: BEARER },
  });
  expect({ status: refused.status, code: await code(refused) }).toEqual({ status: 409, code: "early_access.no_email" });
});

test("no answer carries a secret or a field named like one", async () => {
  const secrets = [
    "sk-ant-api-secret-9876",
    TOKEN,
    t.config.AGENTES_SECRET,
    "machine-token-hash",
    ...(await t.db.select({ token: schema.sessions.token }).from(schema.sessions)).map((r) => r.token),
    ...(await t.db.select({ password: schema.accounts.password }).from(schema.accounts)).flatMap((r) =>
      r.password ? [r.password] : [],
    ),
  ];
  // Early-access links' tokens, in the emails queued above.
  for (const { payload } of await t.db.select({ payload: schema.outbox.payload }).from(schema.outbox)) {
    const email = (payload as { template?: { kind?: string; url?: string } }).template;
    const access = email?.kind === "early_access" && email.url ? new URL(email.url).searchParams.get("access") : null;
    if (access) secrets.push(access);
  }
  expect(secrets.length).toBeGreaterThan(10);
  for (const path of [
    "/health",
    "/orgs?limit=200",
    `/orgs/${acme.orgId}`,
    `/users/${acme.ownerId}`,
    "/signup",
    "/waitlist",
    "/early-access/invitations?limit=200",
  ]) {
    const text = await (await op(path)).text();
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"[^"]*(token|password|secret|hash|cipher|key)[^"]*":/i);
  }
});

test("the OpenAPI document is the committed contract (ADR 0056)", async () => {
  const doc = await body(await op("/openapi.json"));
  const file = Bun.file(`${import.meta.dir}/operator-openapi.json`);
  // After a deliberate change: UPDATE_OPERATOR_OPENAPI=1 bun test apps/server/test/operator.test.ts, then bun run format.
  if (process.env.UPDATE_OPERATOR_OPENAPI === "1") await Bun.write(file, `${JSON.stringify(doc, null, 2)}\n`);
  expect(doc).toEqual(await file.json());
});
