import type { Agent, AgentAccess, AgentUsage, DirectMessage, Mission, WorkingRun } from "@agenteschat/client";
import { previewOf } from "../shared/logic";

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
  /** Mission: its title. Run: the thread's title or the start of its first message (null: say where instead). */
  what: string | null;
  channelId: string;
  /** Null: the main timeline (DMs are flat). */
  threadId: string | null;
  /** Where, for a run without a label: a channel's name, or a DM (no name). */
  where: { kind: "channel" | "dm"; name: string | null };
  missionId: string | null;
  plan: { done: number; total: number } | null;
  /** Since when (the mission's or the run's start, else when it was created). */
  since: string;
}

/**
 * Active missions first (they are long work), then runs in progress (`GET
 * …/active-runs`, everyone's view of the conversations they are in), newest
 * first, one per agent and conversation.
 */
export function workingNow(runs: WorkingRun[] | undefined, missions: Mission[] | undefined): WorkItem[] {
  const out: WorkItem[] = [];
  const seen = new Set<string>();
  const spot = (agentId: string, channelId: string, threadId: string | null) => `${agentId}:${threadId ?? channelId}`;
  for (const m of missions ?? []) {
    if (m.status !== "active") continue;
    out.push({
      key: `m:${m.id}`,
      agentId: m.agentId,
      kind: "mission",
      what: m.title,
      channelId: m.channelId,
      threadId: m.threadId,
      where: { kind: "channel", name: null },
      missionId: m.id,
      plan: { done: m.plan.done, total: m.plan.total },
      since: m.startedAt ?? m.createdAt,
    });
    seen.add(spot(m.agentId, m.channelId, m.threadId));
  }
  const newest = (r: WorkingRun) => r.startedAt ?? r.createdAt;
  for (const r of [...(runs ?? [])].sort((a, b) => newest(b).localeCompare(newest(a)))) {
    const at = spot(r.agentId, r.channelId, r.threadId);
    if (!ACTIVE.has(r.status) || seen.has(at)) continue;
    seen.add(at);
    out.push({
      key: `r:${r.runId}`,
      agentId: r.agentId,
      kind: "run",
      what: r.label?.trim() || null,
      channelId: r.channelId,
      threadId: r.threadId,
      where: { kind: r.channelKind, name: r.channelName },
      missionId: null,
      plan: null,
      since: newest(r),
    });
  }
  return out;
}

/** Agents with something in progress. */
export const busyAgents = (work: WorkItem[]) => new Set(work.map((w) => w.agentId));

/** Conversations where an agent is on something now (an agent DM shows "trabalhando…"). */
export const busyChannels = (work: WorkItem[]) => new Set(work.map((w) => w.channelId));

/** What each working agent is on: its first item (missions come first in `workingNow`). */
export function workByAgent(work: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  return work.filter((w) => !seen.has(w.agentId) && Boolean(seen.add(w.agentId)));
}

/** One agent on Agentes: what it is on (working) or its last conversation (free). */
export interface TeamLine {
  agent: Agent;
  /** What it is on now; null when free. */
  work: WorkItem | null;
  /** Working: since when. Free: its DM's last message. */
  at: string | null;
  /** Free: the last message of its DM (one line), else null. */
  preview: string | null;
}

/**
 * Agentes: "Trabalhando agora" (in `workByAgent` order: missions, then the newest runs) and "Livres" (the
 * latest conversation first, then by name), each agent once.
 */
export function teamLines(
  agents: Agent[],
  work: WorkItem[],
  dms: Pick<DirectMessage, "with" | "lastMessage">[],
): { working: TeamLine[]; free: TeamLine[] } {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const working: TeamLine[] = [];
  for (const w of workByAgent(work)) {
    const agent = byId.get(w.agentId);
    if (agent) working.push({ agent, work: w, at: w.since, preview: null });
  }
  const busy = new Set(working.map((l) => l.agent.id));
  const lastOf = new Map<string, NonNullable<DirectMessage["lastMessage"]>>();
  for (const d of dms) {
    if (d.with.type !== "agent" || !d.lastMessage) continue;
    const prev = lastOf.get(d.with.id);
    if (!prev || d.lastMessage.createdAt > prev.createdAt) lastOf.set(d.with.id, d.lastMessage);
  }
  const free = agents
    .filter((a) => !busy.has(a.id))
    .map((agent): TeamLine => {
      const last = lastOf.get(agent.id);
      return { agent, work: null, at: last?.createdAt ?? null, preview: last ? previewOf(last.body) || null : null };
    })
    .sort((a, b) => {
      if (a.at && b.at) return b.at.localeCompare(a.at);
      if (a.at) return -1;
      if (b.at) return 1;
      return a.agent.name.localeCompare(b.agent.name);
    });
  return { working, free };
}

/** "há 4 min": how long ago, in the largest whole unit (under a minute: now). */
export type Ago = { unit: "now" } | { unit: "minutes" | "hours" | "days"; count: number };

export function agoOf(iso: string, now = Date.now()): Ago {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return { unit: "now" };
  if (min < 60) return { unit: "minutes", count: min };
  const h = Math.floor(min / 60);
  if (h < 24) return { unit: "hours", count: h };
  return { unit: "days", count: Math.floor(h / 24) };
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
