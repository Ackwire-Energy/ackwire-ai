import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateInSteps, migrationsFolder } from "../src/client";

/** Shared synthetic data and rollout assertions for PGlite and the disposable real-Postgres CI rehearsal. */
export interface UpgradeFixtureDatabase {
  exec(statement: string): Promise<unknown>;
  query<T = Record<string, unknown>>(statement: string): Promise<{ rows: T[] }>;
}

export type UpgradeBaseline = "0251" | "0285";

export function upgradeBoundaries(baseline: UpgradeBaseline = "0251") {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const through = (tag: string) => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    if (index < 0) throw new Error(`Missing upgrade boundary ${tag}`);
    return index + 1;
  };
  const initial = through("0251_user_work_area");
  const previous = through("0285_query_sweep");
  const before = baseline === "0251" ? initial : previous;
  const beforeWorkspacePolicy = through("0277_mcp_request_headers");
  const end = through("0296_ackwire_preserve_account_choice");
  expect(previous - initial).toBe(31);
  return { initial, previous, before, beforeWorkspacePolicy, end };
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

      update agents set brain_extra_usage = false where handle in ('existing', 'archived');
      update agents set builtin = 'right_hand' where handle = 'archived';
      insert into machines (id, org_id, name) values
        ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000001', 'Synthetic computer');
      insert into machine_accounts (id, org_id, machine_id, kind, label, created_by) values
        ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000031', 'claude_code', 'Chosen account', 'member');
      update agents set brain_account_id = '00000000-0000-4000-8000-000000000032', brain = 'claude_code', machine_id = '00000000-0000-4000-8000-000000000031' where handle = 'existing';
      insert into agent_runs (id, org_id, agent_id, channel_id, thread_root_id, trigger_message_id, trigger, hop) values
        ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-000000000043', 'mention', 0);
      insert into agent_consultations (id, org_id, asker_run_id, asker_agent_id, target_agent_id, channel_id, message_id, wait_id, question, chain, expires_at) values
        ('00000000-0000-4000-8000-000000000044', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000045', 'legacy-handoff', 'Legacy handoff', array[]::uuid[], now() + interval '1 hour');
    `);
}

export async function verifyLegacyUpgradeFixture(pg: UpgradeFixtureDatabase, baseline: UpgradeBaseline = "0251") {
  const { before } = upgradeBoundaries(baseline);
  expect((await pg.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows).toEqual([{ n: before }]);
  expect((await pg.query("select name from organizations order by name")).rows).toEqual([
    { name: "Open team" },
    { name: "Restricted team" },
  ]);
  // The real server uses its image's locale; PGlite uses C. Keep this fixture's comparison deterministic.
  if (baseline === "0251")
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
    { assignees: baseline === "0251" ? null : "issue_assignees" },
  ]);
  expect(
    (
      await pg.query(
        "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'approvals_level'",
      )
    ).rows,
  ).toEqual([{ n: baseline === "0251" ? 0 : 1 }]);
  await verifySavedPreferences(pg);
  expect(
    (await pg.query("select count(*)::int as n from agent_consultations where question = 'Legacy handoff'")).rows,
  ).toEqual([{ n: 1 }]);
}

export async function upgradeAndVerifyFixture(
  db: unknown,
  pg: UpgradeFixtureDatabase,
  baseline: UpgradeBaseline = "0251",
) {
  const { beforeWorkspacePolicy, end } = upgradeBoundaries();
  // An installation upgraded through 0277 may already have an explicit per-agent approval policy.
  if (baseline === "0251") await seedIntermediateApproval(db, pg, beforeWorkspacePolicy);
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
  await verifySavedPreferences(pg);
  expect((await pg.query("select handle, brain_account_pinned from agents order by handle")).rows).toEqual([
    { handle: "archived", brain_account_pinned: true },
    { handle: "custom-policy", brain_account_pinned: true },
    { handle: "existing", brain_account_pinned: true },
  ]);
  // Upstream 0295 intentionally leaves historical handoffs unattributed: do not invent an initiating person.
  expect(
    (
      await pg.query(
        "select for_user_id, asker_read_outside from agent_consultations where question = 'Legacy handoff'",
      )
    ).rows,
  ).toEqual([{ for_user_id: null, asker_read_outside: false }]);
  await pg.exec(`
    insert into agents (id, org_id, name, handle, model) values
      ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001', 'New agent', 'new', 'new-model');
    update agents set brain_account_pinned = false where handle = 'existing';
    update agent_consultations set for_user_id = 'member', asker_read_outside = true where question = 'Legacy handoff';
  `);
  // Reopening an already upgraded installation must not run backfills or duplicate grants again.
  const beforeRerun = await pg.query("select * from issue_assignees order by issue_id");
  await migrateInSteps(db, migrationsFolder, end);
  expect((await pg.query("select * from issue_assignees order by issue_id")).rows).toEqual(beforeRerun.rows);
  expect(
    (await pg.query("select brain_account_pinned, brain_extra_usage from agents where handle = 'new'")).rows,
  ).toEqual([{ brain_account_pinned: false, brain_extra_usage: true }]);
  expect((await pg.query("select brain_account_pinned from agents where handle = 'existing'")).rows).toEqual([
    { brain_account_pinned: false },
  ]);
  expect(
    (
      await pg.query(
        "select for_user_id, asker_read_outside from agent_consultations where question = 'Legacy handoff'",
      )
    ).rows,
  ).toEqual([{ for_user_id: "member", asker_read_outside: true }]);
  expect((await pg.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows).toEqual([{ n: end }]);
  expect(
    (await pg.query("select approvals_level, approvals_level_own from agents where handle = 'custom-policy'")).rows,
  ).toEqual([{ approvals_level: "always", approvals_level_own: true }]);
  const { rows: duplicate } = await pg.query<{ n: number }>(
    "select count(*)::int as n from org_roles where cardinality(permissions) <> (select count(distinct p) from unnest(permissions) p)",
  );
  expect(duplicate[0]?.n).toBe(0);
}

async function seedIntermediateApproval(db: unknown, pg: UpgradeFixtureDatabase, count: number) {
  await migrateInSteps(db, migrationsFolder, count);
  await pg.exec("update agents set approvals_level = 'always' where handle = 'custom-policy'");
}

/** Seed at 0251, then optionally prepare the already deployed 0285 baseline before taking its backup. */
export async function prepareUpgradeFixture(db: unknown, pg: UpgradeFixtureDatabase, baseline: UpgradeBaseline) {
  const { initial, previous, beforeWorkspacePolicy } = upgradeBoundaries(baseline);
  await migrateInSteps(db, migrationsFolder, initial);
  await seedUpgradeFixture(pg);
  if (baseline === "0285") {
    await seedIntermediateApproval(db, pg, beforeWorkspacePolicy);
    await migrateInSteps(db, migrationsFolder, previous);
  }
}

async function verifySavedPreferences(pg: UpgradeFixtureDatabase) {
  expect(
    (
      await pg.query(
        "select handle, brain_extra_usage, brain_account_id::text from agents where handle <> 'new' order by handle",
      )
    ).rows,
  ).toEqual([
    { handle: "archived", brain_extra_usage: false, brain_account_id: null },
    { handle: "custom-policy", brain_extra_usage: true, brain_account_id: null },
    { handle: "existing", brain_extra_usage: false, brain_account_id: "00000000-0000-4000-8000-000000000032" },
  ]);
}
