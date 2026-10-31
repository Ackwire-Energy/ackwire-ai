import { CONNECTOR_CATALOG, type ConnectorCategory } from "./catalog";
import { MCP_PRESETS } from "./presets";

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
