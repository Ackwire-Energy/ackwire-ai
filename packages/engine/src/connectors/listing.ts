import type { MailAdapters } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { type MailAccountRow, mailProviders, orgMailAccounts, usableAccount } from "../mail/accounts";
import type { ToolDefinition } from "../tools/types";
import { CONNECTOR_CATALOG, type ConnectorCategory } from "./catalog";
import { activeConnections } from "./connections";
import { isCustom } from "./custom";
import { MCP_PRESETS, presetForServer } from "./presets";

/**
 * Brand icons the web app serves, keyed by icon name. One color, from
 * `apps/web/public/connectors` (Simple Icons, CC0, or the brand's own mark:
 * see the README there): drawn in the brand color, no color = the ink
 * (near-black, very light or many-colored brands). `own`: from
 * `apps/web/public/brands`, in its maker's colors, which one color would
 * flatten (PayPal's three blues, Canva's gradient).
 */
export const CONNECTOR_BRANDS: Record<string, { file: string; color: string | null; own?: true }> = {
  github: { file: "github", color: null },
  linear: { file: "linear", color: "#5E6AD2" },
  sentry: { file: "sentry", color: null },
  notion: { file: "notion", color: null },
  drive: { file: "googledrive", color: "#4285F4" },
  atlassian: { file: "atlassian", color: "#0052CC" },
  asana: { file: "asana", color: "#F06A6A" },
  stripe: { file: "stripe", color: "#635BFF" },
  supabase: { file: "supabase", color: "#3FCF8E" },
  cloudflare: { file: "cloudflare", color: "#F38020" },
  intercom: { file: "intercom", color: null },
  zapier: { file: "zapier", color: "#FF4F00" },
  webflow: { file: "webflow", color: "#146EF5" },
  square: { file: "square", color: null },
  paypal: { file: "paypal", color: null, own: true },
  canva: { file: "canva", color: null, own: true },
  gitlab: { file: "gitlab", color: "#FC6D26" },
  neon: { file: "neon", color: "#00E599" },
  prisma: { file: "prisma", color: null },
  netlify: { file: "netlify", color: "#00C7B7" },
  vercel: { file: "vercel", color: null },
  railway: { file: "railway", color: null },
  datadog: { file: "datadog", color: "#632CA6" },
  grafana: { file: "grafana", color: "#F46800" },
  postman: { file: "postman", color: "#FF6C37" },
  jam: { file: "jam", color: "#FF4063" },
  resend: { file: "resend", color: null },
  monday: { file: "monday", color: null },
  clickup: { file: "clickup", color: "#7B68EE" },
  todoist: { file: "todoist", color: "#E44332" },
  figma: { file: "figma", color: null },
  airtable: { file: "airtable", color: "#18BFFF" },
  dropbox: { file: "dropbox", color: "#0061FF" },
  miro: { file: "miro", color: null },
  gamma: { file: "gamma", color: null },
  granola: { file: "granola", color: null },
  fireflies: { file: "fireflies", color: "#DA4292" },
  mercadopago: { file: "mercadopago", color: "#00B1EA" },
  attio: { file: "attio", color: null },
  close: { file: "close", color: null },
  calendly: { file: "calendly", color: "#006BFF" },
  posthog: { file: "posthog", color: null },
  mixpanel: { file: "mixpanel", color: "#7856FF" },
  amplitude: { file: "amplitude", color: "#1E61F0" },
  himetrica: { file: "himetrica", color: "#F97015" },
  meta: { file: "meta", color: "#0467DF" },
  klaviyo: { file: "klaviyo", color: null },
  millionsend: { file: "millionsend", color: null },
  semrush: { file: "semrush", color: "#FF642D" },
  ahrefs: { file: "ahrefs", color: "#FF8800" },
  wix: { file: "wix", color: null },
  sanity: { file: "sanity", color: "#F03E2F" },
  contentful: { file: "contentful", color: "#2478CC" },
  jotform: { file: "jotform", color: "#FF6100" },
  tally: { file: "tally", color: null },
  expo: { file: "expo", color: null },
  revenuecat: { file: "revenuecat", color: "#F2545B" },
  superwall: { file: "superwall", color: null },
  paddle: { file: "paddle", color: null },
  abacatepay: { file: "abacatepay", color: "#337D63" },
};

export interface ConnectorListingEntry {
  id: string;
  label: string;
  description: string;
  /** `catalog`: our connector with its own scopes; `remote_mcp`: a vendor's official MCP server (one click). */
  kind: "catalog" | "remote_mcp";
  category: ConnectorCategory;
  auth: ("oauth" | "api_key")[];
  /** Signs in with OAuth here: our OAuth app, or the vendor's MCP OAuth (no app to register). */
  oauthConfigured: boolean;
  /** Can be connected on this server (an OAuth app or an API key). */
  available: boolean;
  /** A one-click server whose vendor hasn't approved agentes.chat yet: listed, not connectable ("Em breve"). */
  soon: boolean;
  needsServerUrl: boolean;
  /** The MCP endpoint of a `remote_mcp` entry. */
  serverUrl: string | null;
  /** Served by the web app: `/connectors/{file}.svg` (one color) or `/brands/{file}.svg` (its own colors); null for a monogram. */
  iconUrl: string | null;
  brandColor: string | null;
  scopes: { id: string; label: string; description: string; sensitive: boolean }[];
  tools: { name: string; scope: string; sensitive: boolean }[];
}

const brand = (key: string) => {
  const b = CONNECTOR_BRANDS[key];
  return { iconUrl: b ? `/${b.own ? "brands" : "connectors"}/${b.file}.svg` : null, brandColor: b?.color ?? null };
};

/**
 * One list for "Adicionar conector": our catalog connectors and the one-click
 * presets. A service in both (Linear, Sentry) shows once: our connector when
 * this server has its OAuth app, else the one-click preset.
 */
export function connectorListing(oauthApps: Record<string, unknown>): ConnectorListingEntry[] {
  const presetIds = new Set(MCP_PRESETS.map((p) => p.id));
  const builtinWins = new Set<string>();
  const builtins: ConnectorListingEntry[] = [];
  for (const d of Object.values(CONNECTOR_CATALOG)) {
    const oauthConfigured = Boolean(d.oauth && oauthApps[d.id]);
    if (presetIds.has(d.id) && !oauthConfigured) continue;
    builtinWins.add(d.id);
    const sensitiveScopes = new Set(Object.values(d.tools).flatMap((t) => (t.sensitive ? [t.scope] : [])));
    builtins.push({
      id: d.id,
      label: d.label,
      description: d.description,
      kind: "catalog",
      category: d.category,
      auth: d.auth,
      oauthConfigured,
      available: oauthConfigured || d.auth.includes("api_key"),
      soon: false,
      needsServerUrl: d.serverUrl === null,
      serverUrl: d.serverUrl,
      ...brand(d.id),
      scopes: Object.entries(d.scopes).map(([id, s]) => ({
        id: `${d.id}:${id}`,
        label: s.label,
        description: s.description,
        sensitive: sensitiveScopes.has(id),
      })),
      tools: Object.entries(d.tools).map(([name, t]) => ({
        name,
        scope: `${d.id}:${t.scope}`,
        sensitive: t.sensitive === true,
      })),
    });
  }
  const presets: ConnectorListingEntry[] = MCP_PRESETS.filter((p) => !builtinWins.has(p.id)).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    kind: "remote_mcp",
    category: p.category,
    auth: ["oauth"],
    oauthConfigured: true,
    available: !p.soon,
    soon: p.soon === true,
    needsServerUrl: false,
    serverUrl: p.serverUrl,
    ...brand(p.icon),
    scopes: [],
    tools: [],
  }));
  return [...builtins, ...presets];
}

/** What this server's "Adicionar conector" can connect: its OAuth apps (`connectorOAuthApps`) and its mail paths. */
export interface ServerCatalog {
  oauthApps: Record<string, unknown>;
  mail?: MailAdapters | null;
}

/** A connector of "Adicionar conector" the agent has no tool of, as `find_tools` names it (ADR 0043). */
export interface MissingConnector {
  label: string;
  description: string;
  /** What names it in a search: its label and its ids (`drive`). */
  names: string[];
  /**
   * `unavailable`: this server can't connect it; `soon`: its vendor hasn't approved agentes.chat yet (a `soon`
   * preset); `not_connected`: the workspace hasn't; `not_given`: the agent lacks it; `needs_reconnect`: a mailbox of
   * it stopped working.
   */
  state: "unavailable" | "soon" | "not_connected" | "not_given" | "needs_reconnect";
}

/** The mailboxes "Adicionar conector" offers, by the rule of `mailChoices` (apps/web/src/components/MailConnect.tsx). */
const MAILBOXES: {
  label: string;
  description: string;
  /** Words besides its label that name it in a search. */
  names?: string[];
  offered: (mail: ReturnType<typeof mailProviders>) => boolean;
  holds: (account: MailAccountRow) => boolean;
}[] = [
  {
    label: "Gmail",
    description: "Read, organize and answer Gmail email.",
    offered: (m) => m.composio,
    holds: (a) => a.provider === "gmail",
  },
  {
    label: "Outlook",
    description: "Outlook and Microsoft 365 email.",
    offered: (m) => m.composio,
    holds: (a) => a.provider === "outlook",
  },
  {
    label: "iCloud",
    description: "iCloud email, custom domains included.",
    offered: (m) => m.imap && m.presets.some((p) => p.id === "icloud"),
    holds: (a) => a.preset === "icloud",
  },
  {
    label: "Email",
    description: "A mailbox: Gmail, Outlook, iCloud or another provider.",
    names: ["mail", "mailbox"],
    offered: (m) => m.composio || m.imap,
    holds: () => true,
  },
];

type Tools = Iterable<Pick<ToolDefinition, "connectionId">>;

/**
 * The connectors of "Adicionar conector" (`connectorListing` and the mailboxes) the agent has no tool of, and why.
 * `usable`: the agent's tools; `listed`: every tool this server lists for the workspace. Names and states only:
 * never a connection's account, address or key.
 */
export async function missingConnectors(
  db: Database,
  orgId: string,
  catalog: ServerCatalog,
  tools: { usable: Tools; listed: Tools },
): Promise<MissingConnector[]> {
  const [connections, mailboxes] = await Promise.all([activeConnections(db, orgId), orgMailAccounts(db, orgId)]);
  const services = new Map<
    string,
    {
      label: string;
      description: string;
      names: Set<string>;
      offered: boolean;
      soon: boolean;
      held: string[];
      reconnect: boolean;
    }
  >();
  const service = (label: string, description: string) => {
    const key = label.toLowerCase();
    const found = services.get(key) ?? {
      label,
      description,
      names: new Set([label]),
      offered: false,
      soon: false,
      held: [],
      reconnect: false,
    };
    services.set(key, found);
    return found;
  };
  for (const entry of connectorListing(catalog.oauthApps)) {
    const s = service(entry.label, entry.description);
    s.names.add(entry.id);
    s.offered ||= entry.available;
    s.soon ||= entry.soon;
  }
  const mail = mailProviders(catalog.mail);
  for (const m of MAILBOXES) {
    const s = service(m.label, m.description);
    for (const name of m.names ?? []) s.names.add(name);
    s.offered ||= m.offered(mail);
    const own = mailboxes.filter(m.holds);
    s.held.push(...own.filter(usableAccount).map((a) => a.id));
    // Connecting the same mailbox again fails as already connected: only Reconnect on its row brings it back.
    s.reconnect ||= own.some((a) => a.status === "needs_reconnect");
  }
  // A server connected by address is its preset's service, or the one it was named after (a mailbox's too).
  for (const c of connections) {
    const label = isCustom(c)
      ? (presetForServer(c.serverUrl)?.label ?? c.label)
      : (CONNECTOR_CATALOG[c.connector]?.label ?? c.label);
    services.get(label.toLowerCase())?.held.push(c.id);
  }
  const ids = (list: Tools) => new Set([...list].map((t) => t.connectionId));
  const [usable, listed] = [ids(tools.usable), ids(tools.listed)];
  return [...services.values()].flatMap((s): MissingConnector[] => {
    if (s.held.some((id) => usable.has(id))) return [];
    let state: MissingConnector["state"];
    if (s.held.some((id) => listed.has(id))) state = "not_given";
    else if (s.reconnect) state = "needs_reconnect";
    // Connected, but no tool of it listed (server down, not reviewed yet): nothing says the agent lacks it.
    else if (s.held.length > 0) return [];
    else state = s.offered ? "not_connected" : s.soon ? "soon" : "unavailable";
    return [{ label: s.label, description: s.description, names: [...s.names], state }];
  });
}
