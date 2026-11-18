import type { Agent, Approval, ApprovalsLevel, AuditRow } from "../api/types";
import { can } from "./permissions";

/** The levels as the choice lists them, the one that asks most first. */
export const APPROVALS_LEVELS: readonly ApprovalsLevel[] = ["always", "risky", "never"];

/** An agent's level (ADR 0173): one from an older server, which doesn't say, asks for what is risky. */
export const approvalsLevelOf = (agent: Pick<Agent, "approvalsLevel"> | null | undefined): ApprovalsLevel =>
  agent?.approvalsLevel ?? "risky";

/** The level while a change is on its way: what was asked for, else what is saved. */
export const shownApprovalsLevel = (
  agent: Pick<Agent, "approvalsLevel"> | null | undefined,
  update: { isPending: boolean; variables?: { approvalsLevel?: ApprovalsLevel | null } | undefined },
): ApprovalsLevel => (update.isPending ? update.variables?.approvalsLevel : undefined) ?? approvalsLevelOf(agent);

/** A call in the audit that ran without its approval card because its agent never asks. */
export const auditUnasked = (row: Pick<AuditRow, "details">) => row.details.approvalsLevel === "never";

/** It follows the workspace's level ("Segue o workspace"); an older server doesn't say, so it doesn't show. */
export const followsWorkspace = (agent: Pick<Agent, "approvalsLevelOwn"> | null | undefined) =>
  agent?.approvalsLevelOwn === false;

/** How many agents keep their own level when the workspace's changes. */
export const ownApprovalsCount = (agents: readonly Pick<Agent, "approvalsLevelOwn">[]) =>
  agents.filter((a) => a.approvalsLevelOwn === true).length;

/**
 * "Mudar quando perguntar" on a waiting approval: for who decides it and may also set the agent's level
 * (`manage_agents`), so the choice it opens can be saved.
 */
export const changesWhenAsks = (
  org: { permissions?: readonly string[] } | null | undefined,
  approval: Pick<Approval, "status" | "canDecide">,
) => approval.status === "pending" && approval.canDecide && can(org, "manage_agents");

/** What "Desfazer" puts back after a level was chosen: the workspace's level and each agent's own choice. */
export interface LevelsBefore {
  workspace: ApprovalsLevel;
  /** Each agent's own level, null for one that followed the workspace. */
  agents: { id: string; level: ApprovalsLevel | null }[];
}

/**
 * The levels a change can touch, before it: one agent's alone (`only`), or, for every agent, the workspace's and
 * every agent's own choice that the change clears.
 */
export const levelsBefore = (
  workspace: ApprovalsLevel,
  agents: readonly Pick<Agent, "id" | "approvalsLevel" | "approvalsLevelOwn">[],
  only?: string,
): LevelsBefore => ({
  workspace,
  agents: agents
    .filter((a) => (only ? a.id === only : a.approvalsLevelOwn === true))
    .map((a) => ({ id: a.id, level: a.approvalsLevelOwn === false ? null : approvalsLevelOf(a) })),
});
