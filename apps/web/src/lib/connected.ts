import type { TFunction } from "i18next";
import type { Connection, ConnectorDef, CustomServer } from "@/api/types";
import { exposedTools, sameServer, toolsToReview } from "@/lib/custom-tools";
import { connectorName } from "@/lib/scopes";

/**
 * One row of "Conectados", whatever the kind: a catalog connection (GitHub
 * with our scopes) or an MCP server connected by address (a one-click
 * preset or any other). Both are connections: the id is the connection id.
 */
export interface ConnectedItem {
  id: string;
  /** An MCP server by address: its tools are reviewed here. */
  custom: boolean;
  label: string;
  /** The catalog entry (also the preset a custom server came from): icon, scopes. */
  def: ConnectorDef | null;
  /** "acme" (the account), or the server's host. */
  account: string | null;
  createdAt: string;
  /** Tools agents can be given. */
  tools: number;
  /** Tools waiting for a decision. */
  pending: number;
  /** Never reviewed, or new tools to review. */
  needsReview: boolean;
  server: CustomServer | null;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function fromConnection(c: Connection, catalog: ConnectorDef[]): ConnectedItem {
  const def = catalog.find((d) => d.id === c.connector) ?? null;
  return {
    id: c.id,
    custom: false,
    label: def?.label ?? c.label,
    def,
    account: c.accountLabel,
    createdAt: c.createdAt,
    tools: def?.tools.length ?? 0,
    pending: 0,
    needsReview: false,
    server: null,
  };
}

export function fromServer(s: CustomServer, catalog: ConnectorDef[]): ConnectedItem {
  const pending = toolsToReview(s);
  return {
    id: s.id,
    custom: true,
    label: s.label,
    def: catalog.find((d) => d.kind === "remote_mcp" && sameServer(d.serverUrl, s.serverUrl)) ?? null,
    account: host(s.serverUrl),
    createdAt: s.createdAt,
    tools: exposedTools(s).length,
    pending,
    needsReview: !s.reviewedAt || pending > 0,
    server: s,
  };
}

/** Every active connection, oldest first. */
export function connectedItems(connections: Connection[], servers: CustomServer[], catalog: ConnectorDef[]) {
  return [
    ...connections.filter((c) => !c.revokedAt).map((c) => fromConnection(c, catalog)),
    ...servers.map((s) => fromServer(s, catalog)),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Catalog ids that are connected (a preset counts when a server has its address). */
export function connectedIds(items: ConnectedItem[]) {
  return new Set(items.flatMap((i) => (i.def ? [i.def.id] : [])));
}

/** The name a connected service shows, in the app's language (the catalog's name when it came from the catalog). */
export function itemName(t: TFunction, item: Pick<ConnectedItem, "def" | "label">) {
  return item.def ? connectorName(t, item.def) : item.label;
}
