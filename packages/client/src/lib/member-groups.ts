import type { MemberPresence, OrgRole, Role } from "../api/types";
import { isRightHand } from "./right-hand";

interface GroupPerson {
  userId: string;
  name: string;
  role: Role;
  roleIds?: string[];
}

interface GroupAgent {
  id: string;
  name: string;
  builtin?: "right_hand" | null;
}

export type MemberRow<P, A> = { kind: "person"; person: P } | { kind: "agent"; agent: A };

export interface MemberGroup<P, A> {
  /** `owner`, `role:<id>`, `agents`, `online` or `offline`. */
  key: string;
  /** Set on a hoisted role's group: its name and mark. */
  role?: OrgRole;
  rows: MemberRow<P, A>[];
}

/** The color of a person's name in a conversation: the mark of their highest role; an owner's is the owners' mark. */
export function memberRoleColor(person: Pick<GroupPerson, "role" | "roleIds">, roles: OrgRole[]) {
  if (person.role === "owner") return "violet";
  const top = roles
    .filter((r) => r.kind !== "everyone" && person.roleIds?.includes(r.id))
    .sort((a, b) => a.position - b.position)[0];
  return top?.color;
}

/** A person here now: online, away or busy. Offline, hidden and out of office read as offline. */
export const isConnected = (p: MemberPresence | undefined) => p === "online" || p === "away" || p === "busy";
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * A channel's members as the members column lists them: the owners online, each hoisted role (top first) with the
 * online people whose highest hoisted role it is, the agents (the right hand first, then busy ones), everyone else
 * online, then offline: the people and the agents off for now (`agentOff`) by name. A person shows once; a hidden one
 * reads offline (ADR 0084). Empty groups are left out.
 */
export function memberGroups<P extends GroupPerson, A extends GroupAgent>({
  people,
  agents,
  roles,
  presenceOf,
  busy,
  agentOff = () => false,
}: {
  people: P[];
  agents: A[];
  roles: OrgRole[];
  presenceOf: (userId: string) => MemberPresence | undefined;
  busy: (agentId: string) => boolean;
  /** Out of office, held or with no AI (`isAgentOff`): under Offline. */
  agentOff?: (agentId: string) => boolean;
}): MemberGroup<P, A>[] {
  const hoisted = roles.filter((r) => r.hoist && r.kind !== "everyone").sort((a, b) => a.position - b.position);
  const owner: P[] = [];
  const byRole = new Map<string, P[]>(hoisted.map((r) => [r.id, []]));
  const online: P[] = [];
  const offline: P[] = [];
  for (const p of [...people].sort(byName)) {
    if (!isConnected(presenceOf(p.userId))) offline.push(p);
    else if (p.role === "owner") owner.push(p);
    else {
      const top = hoisted.find((r) => p.roleIds?.includes(r.id));
      (top ? (byRole.get(top.id) as P[]) : online).push(p);
    }
  }
  const sortedAgents = [...agents].sort(
    (a, b) =>
      Number(isRightHand(b)) - Number(isRightHand(a)) || Number(busy(b.id)) - Number(busy(a.id)) || byName(a, b),
  );
  const person = (ps: P[]) => ps.map((p): MemberRow<P, A> => ({ kind: "person", person: p }));
  const agent = (list: A[]) => list.map((a): MemberRow<P, A> => ({ kind: "agent", agent: a }));
  const named = (r: MemberRow<P, A>) => (r.kind === "person" ? r.person : r.agent);
  const groups: MemberGroup<P, A>[] = [
    { key: "owner", rows: person(owner) },
    ...hoisted.map((r) => ({ key: `role:${r.id}`, role: r, rows: person(byRole.get(r.id) ?? []) })),
    { key: "agents", rows: agent(sortedAgents.filter((a) => !agentOff(a.id))) },
    { key: "online", rows: person(online) },
    {
      key: "offline",
      rows: [...person(offline), ...agent(agents.filter((a) => agentOff(a.id)))].sort((a, b) =>
        byName(named(a), named(b)),
      ),
    },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/**
 * The phone's members sheet: the agents and the people here, then everyone off for now (`off`) by name. Counts are of
 * `all`, rows of `found`: a search filters every group and keeps its count.
 */
export function sheetGroups<W extends { kind: "person" | "agent"; name: string }>(
  all: W[],
  found: W[],
  off: (w: W) => boolean,
) {
  const of = (list: W[], key: "agents" | "people" | "offline") =>
    list.filter((w) => (key === "offline" ? off(w) : !off(w) && (w.kind === "agent") === (key === "agents")));
  return (["agents", "people", "offline"] as const).map((key) => ({
    key,
    count: of(all, key).length,
    rows: key === "offline" ? of(found, key).sort(byName) : of(found, key),
  }));
}
