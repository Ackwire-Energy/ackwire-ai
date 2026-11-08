import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";

/**
 * The workspace menu's "Your workspaces" in the desktop app (ADR 0154): this server's workspaces and every other
 * server's the app reads with its own session (`thisMac.workspaces`), grouped by server, each with its unread count.
 */

/** A workspace of another server, as the desktop app read it (`workspaces.rs`). */
export interface DesktopWorkspace {
  id: string;
  name: string;
  /** A data URL; null shows the workspace's mark. */
  logo: string | null;
  unread: number;
  waiting: number;
}

export interface DesktopServerWorkspaces {
  server: string;
  signedIn: boolean;
  orgs: DesktopWorkspace[];
}

export interface WorkspaceRow {
  id: string;
  name: string;
  logo: string | null;
  unread: number;
  /** The workspace open now. */
  current: boolean;
}

export interface WorkspaceGroup {
  /** The server's origin. */
  server: string;
  /** "agentes.chat" for the Cloud, its host otherwise. */
  name: string;
  cloud: boolean;
  /** The server this page is on. */
  here: boolean;
  rows: WorkspaceRow[];
}

/** How a server reads in the menu: agentes.chat for the Cloud, its host otherwise. */
export const serverLabel = (server: string) => (server === CLOUD_SERVER ? "agentes.chat" : serverHost(server));

/**
 * This server's group first (its workspaces from `me`, its counts from `/me/unread` when it answered), then each other
 * server the app is signed in to with workspaces, in the app's order. A server signed out there, or with none,
 * isn't listed (Preferences › Servers says so).
 */
export function workspaceGroups(input: {
  here: string;
  orgs: { id: string; name: string; logo?: string | null }[];
  currentOrgId: string;
  unread: { orgId: string; unread: number }[] | null;
  others: DesktopServerWorkspaces[];
}): WorkspaceGroup[] {
  const counts = new Map((input.unread ?? []).map((u) => [u.orgId, u.unread]));
  const mine: WorkspaceGroup = {
    server: input.here,
    name: serverLabel(input.here),
    cloud: input.here === CLOUD_SERVER,
    here: true,
    rows: input.orgs.map((o) => ({
      id: o.id,
      name: o.name,
      logo: o.logo ?? null,
      unread: counts.get(o.id) ?? 0,
      current: o.id === input.currentOrgId,
    })),
  };
  const others = input.others
    .filter((s) => s.server !== input.here && s.signedIn && s.orgs.length > 0)
    .map((s) => ({
      server: s.server,
      name: serverLabel(s.server),
      cloud: s.server === CLOUD_SERVER,
      here: false,
      rows: s.orgs.map((o) => ({ id: o.id, name: o.name, logo: o.logo, unread: o.unread, current: false })),
    }));
  return [mine, ...others];
}
