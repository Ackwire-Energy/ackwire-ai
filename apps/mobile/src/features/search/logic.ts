import type { Agent, Channel, DirectMessage, SearchHit, SearchKind } from "@agenteschat/client";

/**
 * Busca (the search bar of Conversas): actions, agents and conversations match the words here; messages
 * and files come from the search API (`GET …/search`, kinds `message` and `file`). Results are grouped
 * (Conversas, Mensagens, Arquivos) with a chip per group.
 */

export type SearchAction = "newConversation" | "newTask" | "newAgent";
export const SEARCH_ACTIONS: SearchAction[] = ["newConversation", "newTask", "newAgent"];

/** What the search API is asked for. */
export const SEARCH_KINDS: SearchKind[] = ["message", "file"];

/** The chips over the results. */
export type SearchFilter = "all" | "chats" | "messages" | "files";
export const SEARCH_FILTERS: SearchFilter[] = ["all", "chats", "messages", "files"];

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
  files: SearchHit[];
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
  const words = Boolean(fold(q));
  return {
    actions: SEARCH_ACTIONS.filter((a) => matches(q, input.actionLabels[a])),
    agents: input.agents.filter((a) => matches(q, a.name, a.role, a.handle)).slice(0, 8),
    channels: input.channels.filter((c) => matches(q, c.name, c.topic)).slice(0, 8),
    dms: input.dms.filter((d) => matches(q, d.with.name, d.with.handle)).slice(0, 8),
    // Only messages that open in the app; with no words, nothing.
    messages: words ? input.hits.filter((h) => h.kind === "message" && h.channelIds.length > 0).slice(0, 20) : [],
    files: words ? input.hits.filter((h) => h.kind === "file").slice(0, 20) : [],
  };
}

/** How many results each chip has ("Tudo" counts every group but the actions). */
export function searchCounts(r: SearchResults): Record<SearchFilter, number> {
  const chats = r.agents.length + r.channels.length + r.dms.length;
  return { all: chats + r.messages.length + r.files.length, chats, messages: r.messages.length, files: r.files.length };
}

/** The results a chip keeps (actions only under "Tudo"). */
export function filterResults(r: SearchResults, filter: SearchFilter): SearchResults {
  const none: SearchResults = { actions: [], agents: [], channels: [], dms: [], messages: [], files: [] };
  switch (filter) {
    case "all":
      return r;
    case "chats":
      return { ...none, agents: r.agents, channels: r.channels, dms: r.dms };
    case "messages":
      return { ...none, messages: r.messages };
    case "files":
      return { ...none, files: r.files };
  }
}

export const isEmpty = (r: SearchResults) =>
  r.actions.length + r.agents.length + r.channels.length + r.dms.length + r.messages.length + r.files.length === 0;
