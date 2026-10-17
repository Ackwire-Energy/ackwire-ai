import type { Agent, AgentAccess, AgentUsage, Mission, Run } from "@agenteschat/client";

/**
 * Who is working now (runs in progress and active missions), the crew on
 * Início, and what an agent's profile shows about its month.
 */

const ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_input"]);

/** Something an agent is on right now. */
export interface WorkItem {
  key: string;
  agentId: string;
  kind: "run" | "mission";
  /** Run: the start of the message it answers. Mission: its title. */
  what: string;
  channelId: string;
  threadId: string;
  missionId: string | null;
  plan: { done: number; total: number } | null;
}

/** Active missions first (they are long work), then runs in progress, one per agent and thread. */
export function workingNow(runs: Run[] | undefined, missions: Mission[] | undefined): WorkItem[] {
  const out: WorkItem[] = [];
  const seen = new Set<string>();
  for (const m of missions ?? []) {
    if (m.status !== "active") continue;
    out.push({
      key: `m:${m.id}`,
      agentId: m.agentId,
      kind: "mission",
      what: m.title,
      channelId: m.channelId,
      threadId: m.threadId,
      missionId: m.id,
      plan: { done: m.plan.done, total: m.plan.total },
    });
    seen.add(`${m.agentId}:${m.threadId}`);
  }
  for (const r of [...(runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!ACTIVE.has(r.status) || seen.has(`${r.agentId}:${r.threadId}`)) continue;
    seen.add(`${r.agentId}:${r.threadId}`);
    out.push({
      key: `r:${r.id}`,
      agentId: r.agentId,
      kind: "run",
      what: r.what,
      channelId: r.channelId,
      threadId: r.threadId,
      missionId: null,
      plan: null,
    });
  }
  return out;
}

/** Agents with something in progress. */
export const busyAgents = (work: WorkItem[]) => new Set(work.map((w) => w.agentId));

/** The crew on Início: working ones first (drawn bigger), then the rest, at most `max`. */
export function crewOf(agents: Agent[], busy: ReadonlySet<string>, max = 6): { agent: Agent; busy: boolean }[] {
  return [...agents]
    .sort((a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)) || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((agent) => ({ agent, busy: busy.has(agent.id) }));
}

/**
 * "Este mês": money only when the API gives it to this person (D39: members
 * see a percentage), else the share of the budget used.
 */
export type Spend =
  | { kind: "money"; spentUsd: number; budgetUsd: number; fraction: number }
  | { kind: "percent"; percent: number; fraction: number };

export function spendOf(input: {
  budgetUsedPercent: number;
  monthlyBudgetUsd?: number | null;
  defaultBudgetUsd?: number;
  usage?: AgentUsage | null;
}): Spend {
  const budget = input.monthlyBudgetUsd ?? input.defaultBudgetUsd ?? null;
  const fraction = Math.min(1, Math.max(0, input.budgetUsedPercent / 100));
  if (input.usage && budget != null && budget > 0)
    return {
      kind: "money",
      spentUsd: input.usage.costUsd,
      budgetUsd: budget,
      fraction: Math.min(1, Math.max(0, input.usage.costUsd / budget)),
    };
  return { kind: "percent", percent: Math.round(Math.max(0, input.budgetUsedPercent)), fraction };
}

/** "Pode usar": the apps it may use (granted or inherited), then the built-in groups, by label. */
export function canUse(access: AgentAccess | null | undefined): { key: string; label: string; app: boolean }[] {
  if (!access) return [];
  const on = (s: string) => s === "granted" || s === "inherited";
  const apps = access.connectors
    .filter((c) => access.all || on(c.state) || c.scopes.some((s) => on(s.state)))
    .map((c) => ({ key: `c:${c.connectionId}`, label: c.label, app: true }));
  const builtins = access.builtins
    .filter((s) => access.all || on(s.state) || s.tools.some((x) => on(x.state)))
    .map((s) => ({ key: `b:${s.scope}`, label: s.label, app: false }));
  return [...apps, ...builtins];
}
