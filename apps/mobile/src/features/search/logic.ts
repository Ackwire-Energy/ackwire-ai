import type { Agent, Channel, DirectMessage, SearchHit } from "@agenteschat/client";

/**
 * Busca (the phone's ⌘K): actions, agents and conversations match the words
 * here; messages come from the search API.
 */

export type SearchAction = "newConversation" | "newTask" | "newAgent";
export const SEARCH_ACTIONS: SearchAction[] = ["newConversation", "newTask", "newAgent"];

/** Lowercase, no accents: "Ação" matches "acao". */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const matches = (q: string, ...fields: (string | null | undefined)[]) => {
  const n = fold(q);
  return !n || fields.some((f) => f && fold(f).includes(n));
};

export interface SearchResults {
  actions: SearchAction[];
  agents: Agent[];
  channels: Channel[];
  dms: DirectMessage[];
  messages: SearchHit[];
}

/** What to show for `q`, given the action labels in the person's language. */
export function searchResults(
  q: string,
  input: {
    actionLabels: Record<SearchAction, string>;
    agents: Agent[];
    channels: Channel[];
    dms: DirectMessage[];
    hits: SearchHit[];
  },
): SearchResults {
  return {
    actions: SEARCH_ACTIONS.filter((a) => matches(q, input.actionLabels[a])),
    agents: input.agents.filter((a) => matches(q, a.name, a.role, a.handle)).slice(0, 8),
    channels: input.channels.filter((c) => matches(q, c.name, c.topic)).slice(0, 8),
    dms: input.dms.filter((d) => matches(q, d.with.name, d.with.handle)).slice(0, 8),
    // Only messages open in the app; with no words, nothing.
    messages: fold(q) ? input.hits.filter((h) => h.kind === "message" && h.channelIds.length > 0).slice(0, 20) : [],
  };
}

export const isEmpty = (r: SearchResults) =>
  r.actions.length + r.agents.length + r.channels.length + r.dms.length + r.messages.length === 0;
