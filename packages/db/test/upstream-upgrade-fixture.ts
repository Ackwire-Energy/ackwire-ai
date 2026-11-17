import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateInSteps, migrationsFolder } from "../src/client";

/** Shared synthetic data and rollout assertions for PGlite and the disposable real-Postgres CI rehearsal. */
export interface UpgradeFixtureDatabase {
  exec(statement: string): Promise<unknown>;
  query<T = Record<string, unknown>>(statement: string): Promise<{ rows: T[] }>;
}

export function upgradeBoundaries() {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const through = (tag: string) => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    if (index < 0) throw new Error(`Missing upgrade boundary ${tag}`);
    return index + 1;
  };
  const before = through("0251_user_work_area");
  const beforeWorkspacePolicy = through("0277_mcp_request_headers");
  const end = through("0285_query_sweep");
  expect(end - before).toBe(31);
  return { before, beforeWorkspacePolicy, end };
}

export async function seedUpgradeFixture(pg: UpgradeFixtureDatabase) {
  await pg.exec(`
      insert into organizations (id, name) values
        ('00000000-0000-4000-8000-000000000001', 'Open team'),
        ('00000000-0000-4000-8000-000000000002', 'Restricted team');
      insert into org_roles (org_id, kind, name, permissions) values
        ('00000000-0000-4000-8000-000000000001', 'everyone', 'everyone', array['post']),
        ('00000000-0000-4000-8000-000000000002', 'everyone', 'everyone', array['post']),
        ('00000000-0000-4000-8000-000000000002', 'custom', 'Makers', array['create_agents']);
      insert into organization_settings (org_id) select id from organizations;
      insert into agents (id, org_id, name, handle, model, archived_at) values
        ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Existing agent', 'existing', 'custom-model', null),
        ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'Custom policy', 'custom-policy', 'custom-model', null),
        ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'Archived agent', 'archived', 'custom-model', now());
      insert into users (id, name, email) values
        ('member', 'Member', 'member@example.test'), ('departed', 'Departed', 'departed@example.test');
      insert into organization_members (org_id, user_id, role)
        values ('00000000-0000-4000-8000-000000000001', 'member', 'member');
      insert into issues (id, org_id, number, title, created_by_type, created_by_id, assignee_type, assignee_id) values
        ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', 1, 'Member task', 'person', 'member', 'person', 'member'),
        ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000001', 2, 'Agent task', 'person', 'member', 'agent', '00000000-0000-4000-8000-000000000011'),
        ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000001', 3, 'Archived task', 'person', 'member', 'agent', '00000000-0000-4000-8000-000000000013'),
        ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000001', 4, 'Departed task', 'person', 'member', 'person', 'departed');
    `);
}

export async function verifyLegacyUpgradeFixture(pg: UpgradeFixtureDatabase) {
  const { before } = upgradeBoundaries();
  expect((await pg.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows).toEqual([{ n: before }]);
  expect((await pg.query("select name from organizations order by name")).rows).toEqual([
    { name: "Open team" },
    { name: "Restricted team" },
  ]);
  // The real server uses its image's locale; PGlite uses C. Keep this fixture's comparison deterministic.
  expect((await pg.query('select name, permissions from org_roles order by name collate "C", org_id')).rows).toEqual([
    { name: "Makers", permissions: ["create_agents"] },
    { name: "everyone", permissions: ["post"] },
    { name: "everyone", permissions: ["post"] },
  ]);
  expect(
    (await pg.query("select handle, model, archived_at is not null as archived from agents order by handle")).rows,
  ).toEqual([
    { handle: "archived", model: "custom-model", archived: true },
    { handle: "custom-policy", model: "custom-model", archived: false },
    { handle: "existing", model: "custom-model", archived: false },
  ]);
  expect((await pg.query("select number, title, assignee_type, assignee_id from issues order by number")).rows).toEqual(
    [
      { number: 1, title: "Member task", assignee_type: "person", assignee_id: "member" },
      { number: 2, title: "Agent task", assignee_type: "agent", assignee_id: "00000000-0000-4000-8000-000000000011" },
      {
        number: 3,
        title: "Archived task",
        assignee_type: "agent",
        assignee_id: "00000000-0000-4000-8000-000000000013",
      },
      { number: 4, title: "Departed task", assignee_type: "person", assignee_id: "departed" },
    ],
  );
  expect((await pg.query("select user_id from organization_members")).rows).toEqual([{ user_id: "member" }]);
  expect((await pg.query("select to_regclass('public.issue_assignees')::text as assignees")).rows).toEqual([
    { assignees: null },
  ]);
  expect(
    (
      await pg.query(
        "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'approvals_level'",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
}

export async function upgradeAndVerifyFixture(db: unknown, pg: UpgradeFixtureDatabase) {
  const { beforeWorkspacePolicy, end } = upgradeBoundaries();
  // An installation upgraded through 0277 may already have an explicit per-agent approval policy.
  await migrateInSteps(db, migrationsFolder, beforeWorkspacePolicy);
  await pg.exec("update agents set approvals_level = 'always' where handle = 'custom-policy'");
  await migrateInSteps(db, migrationsFolder, end);
  const { rows: roles } = await pg.query<{ name: string; org: string; permissions: string[] }>(
    "select name, org_id::text as org, permissions from org_roles order by org_id, kind",
  );
  expect(roles.find((r) => r.org.endsWith("1"))?.permissions).toEqual(["post", "create_agents", "view_all_agents"]);
  expect(roles.find((r) => r.org.endsWith("2") && r.name === "everyone")?.permissions).toEqual([
    "post",
    "view_all_agents",
  ]);
  expect(roles.find((r) => r.name === "Makers")?.permissions).toEqual(["create_agents"]);
  const { rows: agents } = await pg.query(
    "select name, model, approvals_level, approvals_level_own from agents where archived_at is null order by handle",
  );
  expect(agents).toEqual([
    { name: "Custom policy", model: "custom-model", approvals_level: "always", approvals_level_own: true },
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
  expect(applied[0]?.n).toBe(end);
  const assignees = async () =>
    (
      await pg.query(
        "select i.number, a.assignee_type, a.assignee_id, a.position from issue_assignees a join issues i on i.id = a.issue_id order by i.number",
      )
    ).rows;
  expect(await assignees()).toEqual([
    { number: 1, assignee_type: "person", assignee_id: "member", position: 0 },
    { number: 2, assignee_type: "agent", assignee_id: "00000000-0000-4000-8000-000000000011", position: 0 },
  ]);
  expect((await pg.query("select count(*)::int as n from issues")).rows).toEqual([{ n: 4 }]);
  // Reopening an already upgraded installation must not run backfills or duplicate grants again.
  const beforeRerun = await pg.query("select * from issue_assignees order by issue_id");
  await migrateInSteps(db, migrationsFolder, end);
  expect((await pg.query("select * from issue_assignees order by issue_id")).rows).toEqual(beforeRerun.rows);
  expect(
    (await pg.query("select approvals_level, approvals_level_own from agents where handle = 'custom-policy'")).rows,
  ).toEqual([{ approvals_level: "always", approvals_level_own: true }]);
  const { rows: duplicate } = await pg.query<{ n: number }>(
    "select count(*)::int as n from org_roles where cardinality(permissions) <> (select count(distinct p) from unnest(permissions) p)",
  );
  expect(duplicate[0]?.n).toBe(0);
}
