import { afterAll, beforeAll, expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";
import { schema, sql } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp, type OperatorDeps, serveOperatorApi } from "../src/operator/app";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

const TOKEN = "operator-test-token-".padEnd(48, "x");
const BEARER = `Bearer ${TOKEN}`;

let t: TestServer;
let deps: OperatorDeps;
/** A request to the operator API with this `Authorization` header (null: none). */
let op: (path: string, authorization?: string | null) => Promise<Response>;
let acme: { orgId: string; ownerId: string };

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  deps = { db: t.db, config: t.config, version: "test", log: createLogger("error") };
  const app = createOperatorApp(deps, TOKEN);
  op = async (path, authorization = BEARER) =>
    app.request(`/api/operator/v1${path}`, { headers: authorization === null ? {} : { authorization } });

  const owner = browser(t);
  await signUp(owner, "owner@acme.test");
  const { orgId } = await seedOrg(owner);
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  if (!user) throw new Error("no user");
  acme = { orgId, ownerId: user.id };

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
  orgs: { id: string; name: string; createdAt: string; members: number; agents: number }[];
  next: string | null;
};

test("without OPERATOR_API_TOKEN nothing listens; the public listener never serves the operator API", async () => {
  expect(serveOperatorApi({ ...deps, config: testConfig() })).toBeNull();

  const server = serveOperatorApi({ ...deps, config: testConfig({ OPERATOR_API_TOKEN: TOKEN, HOST: "127.0.0.1" }) }, 0);
  if (!server) throw new Error("no operator listener");
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/api/operator/v1/health`, { headers: { authorization: BEARER } });
    expect(await health.json()).toEqual({ ok: true, version: "test" });
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

test("health", async () => {
  expect(await body(await op("/health"))).toEqual({ ok: true, version: "test" });
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
  expect(orgs).toEqual([{ id: acme.orgId, name: "Acme", createdAt: expect.any(String), members: 1, agents: 1 }]);

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
  expect(secrets.length).toBeGreaterThan(10);
  for (const path of ["/health", "/orgs?limit=200", `/orgs/${acme.orgId}`, `/users/${acme.ownerId}`]) {
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
