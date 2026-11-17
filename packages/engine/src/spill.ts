import { and, type Executor, eq, isNull, ne, schema, sql } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import { claudeCodeModel, planOf } from "@agenteschat/providers/plans";
import type { Agent } from "./agents";
import { type BrainPlan, computerBrainUnavailable, planIsOwners, storedPlanUsage } from "./brains/select";
import type { BrainAccount } from "./brains/types";
import { machineRule, mayUseDevice } from "./devices";
import type { MachineStatus } from "./machine-hub";

const { agentRuns, machineAccounts, machines } = schema;

/** Where a spilled run thinks (`Transcript.spill`): `from` is the agent's own computer, which was full. */
export interface SpillRecord {
  from: string;
  to: string;
}

type SpillDeps = { db: Executor; machines?: { status(machineId: string): Promise<MachineStatus | null> } };

/**
 * The run's computer plan moved to `machineId`, on a sign-in there the agent's owner has (an account of theirs, else
 * the computer's own sign-in when they connected it): null when that plan can't think there now.
 */
export async function spillPlan(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  machineId: string,
  session: { id: string; resume: boolean },
): Promise<BrainPlan | null> {
  if (plan.kind === "model" || !deps.machines) return null;
  const [status, row] = await Promise.all([
    deps.machines.status(machineId).catch(() => null),
    deps.db
      .select({
        id: machineAccounts.id,
        label: machineAccounts.label,
        status: machineAccounts.status,
        provider: machineAccounts.provider,
      })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.orgId, agent.orgId),
          eq(machineAccounts.machineId, machineId),
          eq(machineAccounts.kind, plan.kind),
          eq(machineAccounts.status, "active"),
          eq(machineAccounts.createdBy, agent.ownerUserId ?? ""),
        ),
      )
      .limit(1)
      .then(([r]) => r),
  ]);
  const account: BrainAccount | undefined = row
    ? { id: row.id, label: row.label, status: "active", ...(row.provider ? { provider: row.provider } : {}) }
    : undefined;
  const usage = await storedPlanUsage(deps.db, agent.orgId, machineId, plan.kind, account?.id).catch(() => null);
  const model =
    plan.kind === "claude_code" && plan.model && !isAutoModel(plan.model)
      ? claudeCodeModel(planOf(account?.provider), plan.model)
      : plan.model;
  const ownersPlan = await planIsOwners(
    deps.db,
    { orgId: agent.orgId, ownerUserId: agent.ownerUserId },
    machineId,
    account,
  );
  if (computerBrainUnavailable(plan.kind, machineId, status, Date.now(), account, ownersPlan, usage, model))
    return null;
  const { account: _home, usage: _homeUsage, ...rest } = plan;
  return {
    ...rest,
    ...(model ? { model } : {}),
    session: { ...session, machineId, cwd: "" },
    ...(account ? { account } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Online computers of the workspace other than `home` that take spill-over for someone, with nothing in their line. */
const spillable = (orgId: string, home: string) =>
  and(
    eq(machines.orgId, orgId),
    ne(machines.id, home),
    isNull(machines.deletedAt),
    eq(machines.online, true),
    eq(machines.paused, false),
    eq(machines.execAllowed, true),
    sql`(${machines.spillOwn} or ${machines.spillOthers})`,
    sql`${machines.executors}->>'mode' is distinct from 'system'`,
    sql`not exists (select 1 from ${agentRuns} w where w.org_id = ${machines.orgId}
      and w.waiting_machine_id = ${machines.id} and w.status = 'waiting_input'
      and w.transcript->'waitingForBrain'->>'code' = 'busy')`,
  );

/** Whether a turn waiting behind others on `home` may find another computer (`spillTarget`): worth a look now. */
export async function spillMayHelp(db: Executor, orgId: string, home: string): Promise<boolean> {
  const [row] = await db.select({ id: machines.id }).from(machines).where(spillable(orgId, home)).limit(1);
  return row !== undefined;
}

/**
 * Spill-over: another online computer of the workspace that may think `personId`'s waited-on turn now, while the
 * agent's own (`plan.session.machineId`) is full. Its owner allowed it (`spill_own` for the owner's own turns,
 * `spill_others` for anyone's whose agents may use it), nothing waits in its line, and the agent's owner has a
 * sign-in there. A server install (an OS user per agent) is never one: the agent has no user of its own there.
 */
export async function spillTarget(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  personId: string,
  session: { id: string },
): Promise<{ machineId: string; plan: BrainPlan } | null> {
  const home = plan.session?.machineId;
  if (!home) return null;
  const candidates = await deps.db
    .select()
    .from(machines)
    .where(
      and(
        spillable(agent.orgId, home),
        sql`(${machines.spillOthers} or (${machines.spillOwn} and ${machines.pairedByUserId} = ${personId}))`,
      ),
    )
    .orderBy(
      sql`${machines.pairedByUserId} = ${personId} desc nulls last`,
      sql`${machines.size}->>'memoryGb' desc nulls last`,
    );
  for (const m of candidates) {
    if (m.pairedByUserId !== personId && !(await mayUseDevice(deps.db, agent.orgId, personId, machineRule(m))))
      continue;
    const moved = await spillPlan(deps, agent, plan, m.id, { id: session.id, resume: false });
    if (moved) return { machineId: m.id, plan: moved };
  }
  return null;
}
