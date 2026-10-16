import { isSafeRule, PERMISSION_WAIT_MS, TASK_LIMITS, type TaskDenial } from "@agenteschat/adapters";
import { type Executor, rowsOf, type SQL, schema, sql } from "@agenteschat/db";

const { missionEvents, missions } = schema;

/**
 * The stored side of command approvals (ADR 0029): kept in the mission's
 * feed (`mission_events`), no table of their own. `command_rule`: a command
 * a person allowed for the whole mission ("Aprovar sempre nesta missão");
 * `command_blocked`: commands a task was refused with nobody to ask (its end
 * notice lists them). The prompts themselves live in `mission-commands.ts`.
 */

/**
 * How many command cards (`command_prompt`, see `mission-commands.ts`) of
 * the mission `missionId` (an SQL expression: `m.id`) wait for an answer:
 * nobody decided and its `PERMISSION_WAIT_MS` hasn't passed (the runner
 * stopped asking then). A scalar subquery (`int`).
 */
export const pendingCommandsSql = (missionId: SQL) => sql`(select count(*)::int from ${missionEvents} ce
    where ce.mission_id = ${missionId} and ce.kind = 'command_prompt'
      and ce.created_at > now() - ${sql.raw(`interval '${Math.round(PERMISSION_WAIT_MS / 1000)} seconds'`)}
      and not exists (select 1 from ${missionEvents} cd where cd.mission_id = ce.mission_id
        and cd.kind = 'command_decided' and cd.data->>'promptId' = ce.data->>'promptId'))`;

/** Open command cards per mission (missions without one are left out). */
export async function pendingCommandCounts(db: Executor, missionIds: string[]): Promise<Map<string, number>> {
  if (missionIds.length === 0) return new Map();
  const rows = rowsOf<{ id: string; n: number | string }>(
    await db.execute(sql`select m.id, ${pendingCommandsSql(sql`m.id`)} as n from ${missions} m
      where m.id in (${sql.join(
        missionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`),
  );
  return new Map(rows.filter((r) => Number(r.n) > 0).map((r) => [r.id, Number(r.n)]));
}

/** Every rule a person allowed for the whole mission, oldest first (sent with each work turn). */
export async function missionAllowRules(db: Executor, missionId: string): Promise<string[]> {
  const rows = rowsOf<{ rule: string | null }>(
    await db.execute(sql`select data->>'rule' as rule from ${missionEvents}
      where mission_id = ${missionId}::uuid and kind = 'command_rule'
      order by created_at limit 200`),
  );
  const out: string[] = [];
  for (const r of rows) if (r.rule && isSafeRule(r.rule) && !out.includes(r.rule)) out.push(r.rule);
  return out;
}

/** Adds rules a person allowed for the mission (the ones already there are skipped). */
export async function addMissionAllowRules(
  db: Executor,
  mission: { id: string; orgId: string },
  rules: string[],
  by: { userId: string; promptId?: string | null },
) {
  const have = await missionAllowRules(db, mission.id);
  const fresh = [...new Set(rules)].filter((r) => isSafeRule(r) && !have.includes(r));
  for (const rule of fresh) {
    await db.insert(missionEvents).values({
      orgId: mission.orgId,
      missionId: mission.id,
      kind: "command_rule",
      data: { rule, by: by.userId, ...(by.promptId ? { promptId: by.promptId } : {}) },
    });
  }
  return fresh;
}

/** A task's refused commands (`task.done.denials`), kept for its end notice. */
export async function recordTaskDenials(
  db: Executor,
  task: { id: string; orgId: string; missionId: string | null },
  denials: TaskDenial[] | undefined,
) {
  if (!task.missionId || !denials?.length) return;
  await db.insert(missionEvents).values({
    orgId: task.orgId,
    missionId: task.missionId,
    kind: "command_blocked",
    data: { taskId: task.id, denials: denials.slice(0, TASK_LIMITS.denials) },
  });
}

/** What a task was refused (latest report). */
export async function blockedOfTask(db: Executor, missionId: string, taskId: string): Promise<TaskDenial[]> {
  const rows = rowsOf<{ denials: TaskDenial[] | string | null }>(
    await db.execute(sql`select data->'denials' as denials from ${missionEvents}
      where mission_id = ${missionId}::uuid and kind = 'command_blocked' and data->>'taskId' = ${taskId}
      order by created_at desc limit 1`),
  );
  const raw = rows[0]?.denials;
  const list = typeof raw === "string" ? (JSON.parse(raw) as TaskDenial[]) : (raw ?? []);
  return Array.isArray(list)
    ? list.filter((d) => d && typeof d.command === "string").slice(0, TASK_LIMITS.denials)
    : [];
}
