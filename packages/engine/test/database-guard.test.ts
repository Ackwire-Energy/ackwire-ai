import { expect, test } from "bun:test";
import { guardSql, type SqlRules } from "../src";

const open: SqlRules = { tables: [], hiddenColumns: [] };
const reason = async (sql: string, rules = open) => {
  const r = await guardSql(sql, rules);
  return r.ok ? null : r.reason;
};

test("one SELECT (with WITH, or EXPLAIN without ANALYZE) passes, trailing semicolons and comments out of the body", async () => {
  const r = await guardSql("with x as (select id from orders) select count(*) from x; ", open);
  expect(r).toMatchObject({
    ok: true,
    kind: "select",
    body: "with x as (select id from orders) select count(*) from x",
  });
  expect(r.ok && r.relations).toEqual(["public.orders"]);
  expect(await guardSql("explain select * from analytics.daily", open)).toMatchObject({ ok: true, kind: "explain" });
});

test("anything that writes, locks, sleeps, reads files or runs SQL from text is refused", async () => {
  expect(await reason("delete from orders")).toContain("read-only");
  expect(await reason("select 1; select 2")).toBe("Send exactly one statement per call.");
  expect(await reason("with d as (delete from orders returning *) select * from d")).toContain("DELETE is not allowed");
  expect(await reason("select * into copy from orders")).toBe("SELECT INTO is not allowed.");
  expect(await reason("select * from orders for update")).toContain("FOR UPDATE");
  expect(await reason("explain analyze select 1")).toContain("ANALYZE");
  expect(await reason("explain delete from orders")).toBe("Only EXPLAIN of a SELECT is allowed.");
  expect(await reason("copy orders to stdout")).toContain("read-only");
  expect(await reason("set statement_timeout = 0")).toContain("read-only");
  expect(await reason("do $$ begin end $$")).toContain("read-only");
  expect(await reason("select pg_sleep(10)")).toContain("pg_sleep");
  expect(await reason("select pg_catalog.pg_read_file('/etc/passwd')")).toContain("pg_read_file");
  expect(await reason("select lo_import('/etc/passwd')")).toContain("lo_import");
  expect(await reason("select query_to_xml('delete from orders', true, true, '')")).toContain("query_to_xml");
  expect(await reason("select * from dblink('host=x', 'select 1') as t(a int)")).toContain("dblink");
  expect(await reason("select * from pg_stats")).toContain("pg_catalog.pg_stats");
  expect(await reason("select from where")).toContain("can't parse");
});

test("the agent's tables: other tables refused, CTE names and catalogs fine", async () => {
  const rules = { tables: ["orders", "analytics.daily"], hiddenColumns: [] };
  expect(await reason("select * from orders o join analytics.daily d on true", rules)).toBeNull();
  expect(await reason("with users as (select 1) select * from users", rules)).toBeNull();
  expect(await reason("select relname from pg_class", rules)).toBeNull();
  expect(await reason("select * from users", rules)).toContain(
    "may only read the tables public.orders, analytics.daily",
  );
  expect(await reason("select * from orders where customer_id in (select id from customers)", rules)).toContain(
    "may only read",
  );
});

test("hidden columns: never named, never through * or a whole-row value", async () => {
  const rules = { tables: [], hiddenColumns: ["public.customers.cpf", "users.password_hash"] };
  expect(await reason("select name, phone from customers", rules)).toBeNull();
  expect(await reason("select count(*) from customers", rules)).toBeNull();
  expect(await reason("select * from orders", rules)).toBeNull();
  expect(await reason("select cpf from customers", rules)).toContain("cpf is hidden");
  expect(await reason("select c.CPF from customers c", rules)).toContain("cpf is hidden");
  expect(await reason("select name from customers where cpf like '1%'", rules)).toContain("cpf is hidden");
  expect(await reason("select * from customers", rules)).toContain("instead of *");
  expect(await reason("select c.* from orders o join customers c on c.id = o.customer_id", rules)).toContain("*");
  expect(await reason("select row_to_json(c) from customers c", rules)).toContain("name the columns");
  expect(await reason("select to_jsonb(users) from users", rules)).toContain("name the columns");
});

test("hidden columns: never read under new names through an alias column list", async () => {
  const rules = { tables: [], hiddenColumns: ["public.users.password_hash"] };
  expect(await reason("select c from users as x(a, b, c)", rules)).toContain("alias list");
  expect(await reason("select x.c from users x(a, b, c) join orders o on o.user_id = x.a", rules)).toContain(
    "alias list",
  );
  expect(await reason("select j.c from (users u join orders o on true) as j(a, b, c)", rules)).toContain(
    "alias list",
  );
  expect(await reason("select n from users u, generate_series(1, 3) g(n)", rules)).toContain("alias list");
  // Without hidden columns in the query, alias lists are fine.
  expect(await reason("select n from orders, generate_series(1, 3) g(n)", rules)).toBeNull();
});

test("functions that run SQL from text are refused", async () => {
  expect(await reason("select * from ts_stat('select password_hash::tsvector from users')")).toContain("ts_stat");
  const rewrite = "select ts_rewrite('a'::tsquery, 'select cpf::tsquery, cpf::tsquery from customers')";
  expect(await reason(rewrite)).toContain("ts_rewrite");
  expect(await reason("select * from crosstab('select 1, 2, 3') as t(a int, b int)")).toContain("crosstab");
  expect(await reason("select * from pg_catalog.ts_stat('select 1')")).toContain("ts_stat");
});

test("an unqualified pg_* name is a catalog only when it is one; other pg_* names are public tables under the rules", async () => {
  const rules = { tables: ["orders"], hiddenColumns: [] };
  expect(await reason("select relname from pg_class", rules)).toBeNull();
  expect(await reason("select * from pg_secrets", rules)).toContain("may only read the tables public.orders");
  expect(await reason("select * from pg_catalog.pg_class", rules)).toBeNull();
  const hidden = { tables: [], hiddenColumns: ["pg_accounts.token"] };
  expect(await reason("select token from pg_accounts", hidden)).toContain("token is hidden");
  expect(await guardSql("select id from pg_accounts", open)).toMatchObject({
    ok: true,
    relations: ["public.pg_accounts"],
  });
});
