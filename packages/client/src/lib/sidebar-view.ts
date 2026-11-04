import type { Agent, SidebarPins, SidebarView } from "../api/types";

/** At most this many pinned rows on top of each section (`SIDEBAR_PIN_LIMIT`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_PIN_LIMIT = 5;
export type PinKind = keyof SidebarPins;
/** AGENTES' orders, as its ⋯ menu lists them (`AGENT_SORTS`, packages/engine/src/sidebar-items.ts). */
export const AGENT_SORTS = ["workspace", "mine", "working"] as const satisfies readonly SidebarView["agentSort"][];

/** The view of someone who never changed it. */
export const SIDEBAR_VIEW_DEFAULT: SidebarView = { agentSort: "workspace", showAllAgents: false, pins: null };
const NO_PINS: SidebarPins = { agents: [], channels: [], people: [] };

/**
 * Day one ("Fixar no topo" never used nor dismissed): the person's own agents on top of AGENTES, the most recently
 * active first (`lastActive`: agent id → ISO time of its DM's last message), then by name, at most the limit.
 */
export function dayOnePins(
  agents: readonly Pick<Agent, "id" | "name" | "ownerUserId">[],
  myUserId: string,
  lastActive: ReadonlyMap<string, string> = new Map(),
): string[] {
  return agents
    .filter((a) => a.ownerUserId === myUserId)
    .sort(
      (a, b) => (lastActive.get(b.id) ?? "").localeCompare(lastActive.get(a.id) ?? "") || a.name.localeCompare(b.name),
    )
    .slice(0, SIDEBAR_PIN_LIMIT)
    .map((a) => a.id);
}

/** What shows pinned: the saved pins, or on day one only `dayOne` agents. */
export const pinsOf = (view: SidebarView, dayOne: readonly string[]): SidebarPins =>
  view.pins ?? { ...NO_PINS, agents: [...dayOne] };

/** `id` pinned at the end of its section, or taken off; null when the section already holds the limit. */
export function togglePin(pins: SidebarPins, kind: PinKind, id: string): SidebarPins | null {
  const list = pins[kind];
  if (list.includes(id)) return { ...pins, [kind]: list.filter((x) => x !== id) };
  if (list.length >= SIDEBAR_PIN_LIMIT) return null;
  return { ...pins, [kind]: [...list, id] };
}

/**
 * One group's agents in the person's order (stable): the workspace's, the ones I'm responsible for first (`mine`), or
 * the ones working now first (`working`, `busy` their ids).
 */
export function sortAgents<A extends Pick<Agent, "id" | "ownerUserId">>(
  agents: readonly A[],
  sort: SidebarView["agentSort"],
  myUserId: string,
  busy: ReadonlySet<string> = new Set(),
): A[] {
  if (sort === "workspace") return [...agents];
  const first = (a: A) => (sort === "mine" ? a.ownerUserId === myUserId : busy.has(a.id));
  return [...agents.filter(first), ...agents.filter((a) => !first(a))];
}
