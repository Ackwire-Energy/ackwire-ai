import { afterEach, expect, test } from "bun:test";
import { DatabaseError } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createDatabaseConnection,
  databaseSlugs,
  getAgentDatabases,
  grantScopes,
  isSensitive,
  listDatabaseConnections,
  listDatabaseTables,
  revokeDatabaseConnection,
  setAgentScopes,
  updateDatabaseConnection,
} from "../src";
import { connectDatabase, type DatabaseFixture, databaseSetup, giveDatabase, runContext } from "./database-fixtures";
import { addMember } from "./fixtures";

let d: DatabaseFixture;
afterEach(async () => {
  await d?.close();
  d = undefined as never;
});

test("connecting tests first, seals the password, finds sensitive columns and whether the user can write", async () => {
  d = await databaseSetup();
  const c = await connectDatabase(d);
  expect(c).toMatchObject({
    label: "Produção",
    host: "db.example.com",
    port: 5432,
    database: "app",
    username: "reader",
    sslmode: "require",
    status: "active",
    // PGlite's user is a superuser: the app recommends a read-only one.
    canWrite: true,
  });
  expect(c.suggestedHidden).toEqual(["public.customers.cpf", "public.customers.phone", "public.users.password_hash"]);
  expect(JSON.stringify(c)).not.toContain("s3cret");
  // The driver got the checked address, never the name to resolve again.
  expect(d.opened.at(-1)).toMatchObject({ host: "db.example.com", address: "93.184.216.34", password: "s3cret" });
  const [row] = await d.f.db.select().from(schema.dbConnections).where(eq(schema.dbConnections.id, c.id));
  expect(row?.secretCiphertext).toBeTruthy();
  expect(row?.secretCiphertext).not.toContain("s3cret");
  const member = await addMember(d.f.db, d.f.org.id, "member");
  const listed = await listDatabaseConnections(d.f.db, member.id, d.f.org.id);
  expect(JSON.stringify(listed)).not.toContain("s3cret");
});

test("private hosts, wrong passwords and bad addresses don't connect", async () => {
  d = await databaseSetup();
  const connect = (url: string) => createDatabaseConnection(d.deps, d.f.owner.id, d.f.org.id, { label: "x", url });
  expect(await connect("postgres://u:p@db.internal-company.net/app")).toEqual({ ok: false, error: "blocked_host" });
  expect(await connect("postgres://u:p@localhost/app")).toEqual({ ok: false, error: "blocked_host" });
  expect(await connect("postgres://u:p@169.254.169.254/app")).toEqual({ ok: false, error: "blocked_host" });
  d.state.fail = new DatabaseError("password authentication failed", "auth");
  expect(await connect("postgres://u:p@db.example.com/app")).toEqual({ ok: false, error: "auth" });
  d.state.fail = new DatabaseError("server does not support SSL", "tls");
  expect(await connect("postgres://u:p@db.example.com/app")).toEqual({ ok: false, error: "tls" });
  d.state.fail = null;
  await expect(connect("mysql://u:p@db.example.com/app")).rejects.toThrow("postgres://");
  await expect(connect("postgres://u@db.example.com/app")).rejects.toThrow("password");
  // Members can't connect databases.
  const member = await addMember(d.f.db, d.f.org.id, "member");
  await expect(
    createDatabaseConnection(d.deps, member.id, d.f.org.id, { url: "postgres://u:p@db.example.com/app" }),
  ).rejects.toThrow();
  expect(await listDatabaseConnections(d.f.db, d.f.owner.id, d.f.org.id)).toEqual([]);
});

test("tools follow the agent's access; never part of 'all tools' nor replaced by the agent's other grants", async () => {
  d = await databaseSetup();
  const c = await connectDatabase(d);
  const ctx = await runContext(d.f);
  const names = async () => (await d.tools.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("pg_"));
  await grantScopes(d.f.db, d.f.org.id, d.f.agent.id, [{ connectionId: null, scope: "*" }]);
  expect(await names()).toEqual([]);
  await giveDatabase(d, c.id);
  expect(await names()).toEqual(["pg_producao_describe_table", "pg_producao_list_tables", "pg_producao_query"]);
  const query = (await d.tools.list(ctx)).find((t) => t.name === "pg_producao_query");
  expect(query && isSensitive(query)).toBe(false);
  expect(query?.connectorLabel).toBe("Produção");
  expect(query?.service).toBe("postgres");
  // Replacing the agent's other grants keeps the database one.
  await setAgentScopes(d.f.db, d.f.owner.id, d.f.org.id, d.f.agent.id, [{ connectionId: null, scope: "context:read" }]);
  expect(await names()).toHaveLength(3);
  // Tools turned off for the database never become tools.
  await updateDatabaseConnection(d.deps, d.f.owner.id, d.f.org.id, c.id, { offActions: ["describe_table"] });
  expect(await names()).toEqual(["pg_producao_list_tables", "pg_producao_query"]);
  const access = await getAgentDatabases(d.f.db, d.f.owner.id, d.f.org.id, d.f.agent.id);
  expect(access).toEqual([
    {
      connectionId: c.id,
      level: "read",
      policy: { tables: [], hiddenColumns: [], dailyQueryCap: null, timeoutSeconds: 15 },
    },
  ]);
  await revokeDatabaseConnection(d.deps, d.f.owner.id, d.f.org.id, c.id);
  expect(await names()).toEqual([]);
});

test("queries: read-only, rows as untrusted data, capped at 500, logged without their rows", async () => {
  d = await databaseSetup();
  const c = await connectDatabase(d);
  await giveDatabase(d, c.id);
  const ctx = await runContext(d.f);
  const call = (input: Record<string, unknown>) =>
    d.tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name: "pg_producao_query", input });

  const r = await call({ sql: "select status, count(*) from orders group by 1 order by 1;" });
  if (r.type !== "result") throw new Error("expected a result");
  expect(r.output.isError).toBeUndefined();
  expect(r.output.content).toContain("[Database Produção] 2 rows");
  expect(r.output.content).toContain("columns: status, count");
  expect(r.output.content).toContain('["canceled",233]');
  expect(r.output.content).toContain('<database_rows untrusted="true">');

  const many = await call({ sql: "select id, note from orders where total > $1", params: [5] });
  if (many.type !== "result") throw new Error("expected a result");
  expect(many.output.content).toContain("the first 500 rows (there are more");
  // A value can't close our block.
  expect(many.output.content.match(/<\/?database_rows/g)).toHaveLength(2);

  // Even past the parser, the transaction is read-only.
  const write = await call({ sql: "select nextval('orders_id_seq')" });
  expect(write).toMatchObject({ output: { isError: true } });
  expect(write.type === "result" && write.output.content).toContain("read-only");

  expect(await call({ sql: "update orders set total = 0" })).toMatchObject({
    output: { isError: true, content: expect.stringContaining("Not allowed: Only SELECT") },
  });
  const bad = await call({ sql: "select nope from orders" });
  expect(bad.type === "result" && bad.output.content).toContain("Postgres error:");
  const total = await d.pg.query<{ n: number }>("select count(*)::int as n from orders where total = 0");
  expect(total.rows[0]?.n).toBe(0);

  const log = await d.f.db.select().from(schema.dbQueries).where(eq(schema.dbQueries.connectionId, c.id));
  expect(log.map((q) => q.kind)).toEqual(["query", "query", "query", "query"]);
  expect(log[0]).toMatchObject({ statement: "select status, count(*) from orders group by 1 order by 1", rowCount: 2 });
  expect(JSON.stringify(log)).not.toContain("canceled");
});

test("the agent's rules: tables, hidden columns and the daily cap", async () => {
  d = await databaseSetup();
  const c = await connectDatabase(d);
  await giveDatabase(d, c.id, "read", {
    tables: ["orders", "customers"],
    hiddenColumns: ["customers.cpf"],
    dailyQueryCap: 3,
  });
  const ctx = await runContext(d.f);
  const call = (name: string, input: Record<string, unknown>) =>
    d.tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name: `pg_producao_${name}`, input });

  const tables = await call("list_tables", {});
  if (tables.type !== "result") throw new Error("expected a result");
  expect(tables.output.content).toContain("public.orders (table, ");
  expect(tables.output.content).toContain("One row per order");
  expect(tables.output.content).not.toContain("users");

  const described = await call("describe_table", { table: "customers" });
  expect(described.type === "result" && described.output.content).toContain("cpf text [hidden from you");
  expect(await call("describe_table", { table: "users" })).toMatchObject({
    output: { isError: true, content: expect.stringContaining("may only read the tables") },
  });
  expect(await call("query", { sql: "select cpf from customers" })).toMatchObject({
    output: { isError: true, content: expect.stringContaining("cpf is hidden") },
  });
  // The cap counts what ran: list + describe + this one, then no more today.
  const third = await call("query", { sql: "select name from customers" });
  expect(third.type === "result" && third.output.isError).toBeUndefined();
  expect(await call("query", { sql: "select 1" })).toMatchObject({
    output: { isError: true, content: expect.stringContaining("already ran its 3 queries") },
  });
});

test("a refused password marks the database for reconnecting; a new password brings it back", async () => {
  d = await databaseSetup();
  const c = await connectDatabase(d);
  await giveDatabase(d, c.id);
  // A new password reopens the pool: the next open fails like a changed password would.
  d.state.fail = new DatabaseError("password authentication failed", "auth");
  const r = await updateDatabaseConnection(d.deps, d.f.owner.id, d.f.org.id, c.id, { password: "wrong" });
  expect(r).toEqual({ ok: false, error: "auth" });
  d.state.fail = null;
  const ok = await updateDatabaseConnection(d.deps, d.f.owner.id, d.f.org.id, c.id, { password: "n3w" });
  expect(ok.ok).toBe(true);
  expect(d.opened.at(-1)?.password).toBe("n3w");
  expect(
    (await listDatabaseTables(d.deps, d.f.owner.id, d.f.org.id, c.id)).map((t) => `${t.schema}.${t.name}`),
  ).toEqual(["analytics.daily", "public.customers", "public.orders", "public.users"]);
});

test("slugs per connection are short, plain and distinct", () => {
  expect(
    [
      ...databaseSlugs([
        { id: "a", label: "Produção (réplica)" },
        { id: "b", label: "Produção réplica" },
        { id: "c", label: "!!" },
      ]).values(),
    ].map((s) => s.length <= 20 && /^[a-z0-9]+$/.test(s)),
  ).toEqual([true, true, true]);
});
