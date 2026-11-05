import type { AgentGroup, TeamAgent } from "../api/types";
import { groupOf } from "./agent-groups";

/**
 * Equipe's views (ADR 0148): the list's filters and sort, the org chart's columns and the team map's columns, from
 * what `useTeam` and `useAgentGroups` return. The web and the phone draw the same ones.
 */

export type TeamFilter = "all" | "mine" | "working" | "waiting" | "noOwner";
export type TeamSort = "name" | "role" | "sector" | "owner";

/** The agents a filter and a search (name, handle, role or a channel's name) leave, in the team's order. */
export function filterTeam(
  agents: readonly TeamAgent[],
  opts: {
    filter: TeamFilter;
    q: string;
    meId: string;
    /** Agents with a request waiting for me (`waiting`). */
    waitingIds?: ReadonlySet<string>;
    channelName?: (id: string) => string | undefined;
  },
): TeamAgent[] {
  const q = opts.q.trim().toLowerCase();
  return agents.filter((a) => {
    if (opts.filter === "mine" && a.ownerUserId !== opts.meId) return false;
    if (opts.filter === "working" && !a.busy) return false;
    if (opts.filter === "waiting" && !opts.waitingIds?.has(a.id)) return false;
    if (opts.filter === "noOwner" && a.ownerUserId) return false;
    if (!q) return true;
    const words = [a.name, a.handle, a.role, ...(a.channelIds ?? []).map((id) => opts.channelName?.(id) ?? "")];
    return words.some((w) => w.toLowerCase().includes(q));
  });
}

/** Sorted by a column, ties by name; an empty value goes last either way. */
export function sortTeam(
  agents: readonly TeamAgent[],
  by: TeamSort,
  desc: boolean,
  names: { sector: (agentId: string) => string; owner: (userId: string | null) => string },
): TeamAgent[] {
  const value = (a: TeamAgent) =>
    by === "name" ? a.name : by === "role" ? a.role : by === "sector" ? names.sector(a.id) : names.owner(a.ownerUserId);
  return [...agents].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (!x !== !y) return x ? -1 : 1;
    const c = x.localeCompare(y) * (desc ? -1 : 1);
    return c || a.name.localeCompare(b.name);
  });
}

/** Who an agent reports to on the org chart: its owner, else its setor's lead; null for neither (or one who left). */
export function reportsTo(agent: TeamAgent, groups: readonly AgentGroup[], members: ReadonlySet<string>) {
  if (agent.ownerUserId && members.has(agent.ownerUserId)) return agent.ownerUserId;
  const lead = groupOf(groups, agent.id)?.leadUserId;
  return lead && members.has(lead) ? lead : null;
}

/**
 * The org chart by person: one column per person someone reports to, in the order their first agent was made, and
 * the agents with nobody last (`personId` null). `skip` leaves agents out (the right hand, drawn on its own).
 */
export function chartByPerson(
  agents: readonly TeamAgent[],
  groups: readonly AgentGroup[],
  members: ReadonlySet<string>,
  skip: (a: TeamAgent) => boolean = () => false,
): { personId: string | null; agents: TeamAgent[] }[] {
  const columns = new Map<string | null, TeamAgent[]>();
  for (const a of agents) {
    if (skip(a)) continue;
    const to = reportsTo(a, groups, members);
    columns.set(to, [...(columns.get(to) ?? []), a]);
  }
  const none = columns.get(null);
  columns.delete(null);
  const out = [...columns].map(([personId, list]) => ({ personId, agents: list }));
  return none ? [...out, { personId: null, agents: none }] : out;
}

/**
 * The team map's columns: one per channel with agents in it, in `channelOrder` (the sidebar's), an agent in every
 * channel it is in; then the agents in none (`channelId` null). Channels the viewer doesn't know are left out.
 */
export function mapColumns(
  agents: readonly TeamAgent[],
  channelOrder: readonly string[],
  skip: (a: TeamAgent) => boolean = () => false,
): { channelId: string | null; agents: TeamAgent[] }[] {
  const known = new Set(channelOrder);
  const shown = agents.filter((a) => !skip(a));
  const columns = channelOrder
    .map((channelId) => ({ channelId, agents: shown.filter((a) => a.channelIds?.includes(channelId)) }))
    .filter((c) => c.agents.length > 0);
  const nowhere = shown.filter((a) => !(a.channelIds ?? []).some((id) => known.has(id)));
  return nowhere.length > 0 ? [...columns, { channelId: null, agents: nowhere }] : columns;
}

/**
 * A setor's people and channels: its lead, its substitute and its agents' owners (each once, in that order), and the
 * channels its agents are in (in the team's order of first appearance).
 */
export function sectorReach(group: AgentGroup, agents: readonly TeamAgent[]) {
  const mine = group.agentIds.flatMap((id) => agents.find((a) => a.id === id) ?? []);
  const people = [
    ...new Set(
      [group.leadUserId, group.backupUserId, ...mine.map((a) => a.ownerUserId)].filter((id): id is string => !!id),
    ),
  ];
  const channelIds = [...new Set(mine.flatMap((a) => a.channelIds ?? []))];
  return { agents: mine, people, channelIds };
}

/** What a setor is missing, as a word the apps translate: no lead first, then no substitute; null when covered. */
export const sectorGap = (group: AgentGroup): "noLead" | "noBackup" | null =>
  !group.leadUserId ? "noLead" : !group.backupUserId ? "noBackup" : null;
