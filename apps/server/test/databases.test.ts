import { afterEach, expect, test } from "bun:test";
import { createFakeDatabaseDriver, DatabaseError } from "@agenteschat/adapters";
import { PGlite } from "@electric-sql/pglite";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
let pg: PGlite | undefined;
afterEach(async () => {
  await t?.close();
  await pg?.close();
  t = undefined as never;
  pg = undefined;
});

const resolveHost = async (host: string) => (host.endsWith("example.com") ? ["93.184.216.34"] : ["10.0.0.5"]);

test("without a driver: connecting is a conflict", async () => {
  t = await createTestServer({ resolveHost });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const r = await owner(`/api/app/organizations/${orgId}/databases`, {
    json: { url: "postgres://u:p@db.example.com/app" },
  });
  expect(r.status).toBe(409);
});

test("databases API: connect (tested), never the password back, agent access and rules, tables, disconnect", async () => {
  pg = new PGlite();
  await pg.exec(
    "create table orders (id serial primary key, total int); create table customers (id serial primary key, cpf text);",
  );
  const state: { fail: DatabaseError | null } = { fail: null };
  t = await createTestServer({
    resolveHost,
    databases: createFakeDatabaseDriver({ db: pg, refuse: () => state.fail }),
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const blocked = await api("/databases", { json: { url: "postgres://u:p@10.1.2.3/app" } });
  expect(blocked.status).toBe(422);
  expect(await blocked.json()).toEqual({ error: "blocked_host" });
  state.fail = new DatabaseError("password authentication failed", "auth");
  expect(await (await api("/databases", { json: { url: "postgres://u:p@db.example.com/app" } })).json()).toEqual({
    error: "auth",
  });
  state.fail = null;
  const created = await api("/databases", {
    json: { label: "Produção", provider: "supabase", url: "postgres://reader:s3cret@db.example.com:6543/app" },
  });
  expect(created.status).toBe(201);
  const { connection } = (await created.json()) as { connection: { id: string; suggestedHidden: string[] } };
  expect(connection).toMatchObject({ label: "Produção", provider: "supabase", port: 6543, username: "reader" });
  expect(connection.suggestedHidden).toEqual(["public.customers.cpf"]);

  const listed = await (await api("/databases")).text();
  expect(listed).toContain("Produção");
  expect(listed).not.toContain("s3cret");

  const tables = (await (await api(`/databases/${connection.id}/tables`)).json()) as { tables: { name: string }[] };
  expect(tables.tables.map((x) => x.name)).toEqual(["customers", "orders"]);

  // No rules saved: the sensitive columns are hidden by default.
  const before = (await (await api(`/agents/${agentId}/databases`)).json()) as {
    databases: { level: string; policy: { hiddenColumns: string[] } }[];
  };
  expect(before.databases[0]).toMatchObject({ level: "none", policy: { hiddenColumns: ["public.customers.cpf"] } });
  const set = await api(`/agents/${agentId}/databases/${connection.id}`, {
    method: "PUT",
    json: { level: "read", policy: { tables: ["orders"], hiddenColumns: [], dailyQueryCap: 100, timeoutSeconds: 30 } },
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({
    connectionId: connection.id,
    level: "read",
    policy: { tables: ["public.orders"], hiddenColumns: [], dailyQueryCap: 100, timeoutSeconds: 30 },
  });
  const after = (await (await api("/databases")).json()) as { connections: { agents: { agentId: string }[] }[] };
  expect(after.connections[0]?.agents).toEqual([{ agentId }]);
  const bad = await api(`/agents/${agentId}/databases/${connection.id}`, {
    method: "PUT",
    json: {
      level: "read",
      policy: { tables: ["a.b.c.d"], hiddenColumns: [], dailyQueryCap: null, timeoutSeconds: 15 },
    },
  });
  expect(bad.status).toBe(400);

  const renamed = await api(`/databases/${connection.id}`, {
    method: "PATCH",
    json: { label: "Réplica", offActions: ["describe_table"] },
  });
  expect(await renamed.json()).toMatchObject({ connection: { label: "Réplica", offActions: ["describe_table"] } });

  expect((await api(`/databases/${connection.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await (await api("/databases")).json()).toEqual({ connections: [] });
});
