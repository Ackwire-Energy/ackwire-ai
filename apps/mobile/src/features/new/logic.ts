import type { Agent } from "@agenteschat/client";
import type { ConversationRow } from "../chats/logic";

/**
 * The pure part of "Novo": who a request from the "+" goes to, the
 * request itself, and the name suggested for a new agent.
 */

/**
 * The agents a request can go to, the one you talked to last first: agents with a direct conversation,
 * newest first, then the rest by name. Agents that don't talk to you are left out. The first one is the
 * preselected one.
 */
export function askTargets(agents: readonly Agent[], rows: readonly ConversationRow[]): Agent[] {
  const talkable = agents.filter((a) => a.canTalk !== false);
  const lastAt = new Map<string, string>();
  for (const r of rows) {
    if (r.kind !== "dm" || r.with.type !== "agent" || !r.at) continue;
    const prev = lastAt.get(r.with.id);
    if (!prev || r.at > prev) lastAt.set(r.with.id, r.at);
  }
  return [...talkable].sort((a, b) => {
    const ta = lastAt.get(a.id);
    const tb = lastAt.get(b.id);
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** The agent picked: the one tapped while it can still be asked, else the default (first) one. */
export function pickedTarget(targets: readonly Agent[], tapped: string | null): Agent | null {
  return (tapped ? targets.find((a) => a.id === tapped) : undefined) ?? targets[0] ?? null;
}

/** The message a request becomes in the agent's conversation (null when there is nothing to send). */
export function requestBody(text: string): string | null {
  const body = text.trim();
  return body ? body : null;
}

/** Names offered for a new agent (short, friendly, easy to call). */
export const AGENT_NAMES = ["Lu", "Nina", "Theo", "Iris", "Ada", "Otto", "Clara", "Bento", "Dora", "Rui"] as const;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/** The name suggested for a new agent: the first of `pool` nobody uses yet, else the first with a number. */
export function suggestAgentName(taken: readonly string[], pool: readonly string[] = AGENT_NAMES): string {
  const used = new Set(taken.map(fold));
  const free = pool.find((n) => !used.has(fold(n)));
  if (free) return free;
  const base = pool[0] ?? "Agente";
  for (let i = 2; ; i++) if (!used.has(fold(`${base} ${i}`))) return `${base} ${i}`;
}
