import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { migrateInSteps, migrationsFolder } from "../src/client";

/** Rehearse the Ackwire 0251 database upgrading through the upstream merge's 31 migrations. */
test("the upstream upgrade preserves existing data and deliberate role restrictions", async () => {
  const migrations = readMigrationFiles({ migrationsFolder });
  const before = migrations.findIndex((m) => m.sql.some((s) => s.includes('ADD COLUMN "paused_by_user_id"')));
  expect(before).toBeGreaterThan(0);
  expect(migrations.length - before).toBe(31);
  const pg = new PGlite({ extensions: { vector } });
  const db = drizzle(pg);
  try {
    await migrateInSteps(db, migrationsFolder, before);
    await pg.exec(`
      insert into organizations (id, name) values
        ('00000000-0000-4000-8000-000000000001', 'Open team'),
        ('00000000-0000-4000-8000-000000000002', 'Restricted team');
      insert into org_roles (org_id, kind, name, permissions) values
        ('00000000-0000-4000-8000-000000000001', 'everyone', 'everyone', array['post']),
        ('00000000-0000-4000-8000-000000000002', 'everyone', 'everyone', array['post']),
        ('00000000-0000-4000-8000-000000000002', 'custom', 'Makers', array['create_agents']);
      insert into organization_settings (org_id) select id from organizations;
      insert into agents (org_id, name, handle, model)
        values ('00000000-0000-4000-8000-000000000001', 'Existing agent', 'existing', 'custom-model');
    `);
    await migrateInSteps(db, migrationsFolder);
    const { rows: roles } = await pg.query<{ name: string; org: string; permissions: string[] }>(
      "select name, org_id::text as org, permissions from org_roles order by org_id, kind",
    );
    expect(roles.find((r) => r.org.endsWith("1"))?.permissions).toEqual(["post", "create_agents", "view_all_agents"]);
    expect(roles.find((r) => r.org.endsWith("2") && r.name === "everyone")?.permissions).toEqual([
      "post",
      "view_all_agents",
    ]);
    expect(roles.find((r) => r.name === "Makers")?.permissions).toEqual(["create_agents"]);
    const { rows: agents } = await pg.query("select name, model, approvals_level, approvals_level_own from agents");
    expect(agents).toEqual([
      {
        name: "Existing agent",
        model: "custom-model",
        approvals_level: "risky",
        approvals_level_own: false,
      },
    ]);
    const { rows: applied } = await pg.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    expect(applied[0]?.n).toBe(migrations.length);
    // Reopening an already upgraded installation must not run backfills or duplicate grants again.
    await migrateInSteps(db, migrationsFolder);
    const { rows: duplicate } = await pg.query<{ n: number }>(
      "select count(*)::int as n from org_roles where cardinality(permissions) <> (select count(distinct p) from unnest(permissions) p)",
    );
    expect(duplicate[0]?.n).toBe(0);
  } finally {
    await pg.close();
  }
}, 180_000);
