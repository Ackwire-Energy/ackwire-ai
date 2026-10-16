import type { ConnectorCategory } from "./catalog";
import { canonicalResource } from "./oauth-mcp";

/**
 * One-click connectors: vendors' official remote MCP servers that speak MCP
 * OAuth with Dynamic Client Registration (no app of ours to register). Each
 * was checked on 2026-10-15: the server answers 401 with OAuth, its
 * authorization server publishes a `registration_endpoint` and PKCE S256.
 * They connect like any custom MCP server; after the OAuth, our suggested
 * classification (read tools free, writes approved, destructive ones need
 * approval) is applied at once, and admins can change it.
 *
 * Left out: HubSpot (its authorization server has no dynamic registration:
 * it needs an app registered with HubSpot); Vercel (only clients Vercel
 * reviewed and approved may connect).
 */
export interface McpPreset {
  id: string;
  /** The brand only ("Supabase"): what a variant is ("read-only") is the app's to say, in each language. */
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Icon name in the app's icon set (falls back to a generic plug). */
  icon: string;
  serverUrl: string;
  /**
   * Tools the server itself keeps read-only, suggested as read whatever their
   * name (Supabase's `execute_sql` with `read_only=true` runs as a read-only
   * Postgres user). Every other tool keeps our usual suggestion.
   */
  readTools?: readonly string[];
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "linear",
    category: "product",
    label: "Linear",
    description: "Linear issues, projects and cycles.",
    icon: "linear",
    serverUrl: "https://mcp.linear.app/mcp",
  },
  {
    id: "sentry",
    category: "dev",
    label: "Sentry",
    description: "Sentry errors, issues and releases.",
    icon: "sentry",
    serverUrl: "https://mcp.sentry.dev/mcp",
  },
  {
    id: "notion",
    category: "docs",
    label: "Notion",
    description: "Notion pages and databases.",
    icon: "notion",
    serverUrl: "https://mcp.notion.com/mcp",
  },
  {
    id: "atlassian",
    category: "product",
    label: "Atlassian",
    description: "Jira issues and Confluence pages.",
    icon: "atlassian",
    serverUrl: "https://mcp.atlassian.com/v1/mcp",
  },
  {
    id: "asana",
    category: "product",
    label: "Asana",
    description: "Asana tasks, projects and teams.",
    icon: "asana",
    serverUrl: "https://mcp.asana.com/mcp",
  },
  {
    id: "stripe",
    category: "payments",
    label: "Stripe",
    description: "Stripe customers, payments, subscriptions and invoices.",
    icon: "stripe",
    serverUrl: "https://mcp.stripe.com",
  },
  {
    id: "cloudflare-bindings",
    category: "dev",
    label: "Cloudflare",
    description: "Workers, KV, R2 and D1 of the Cloudflare account.",
    icon: "cloudflare",
    serverUrl: "https://bindings.mcp.cloudflare.com/mcp",
  },
  {
    id: "cloudflare-observability",
    category: "dev",
    label: "Cloudflare",
    description: "Workers logs and metrics.",
    icon: "cloudflare",
    serverUrl: "https://observability.mcp.cloudflare.com/mcp",
  },
  {
    id: "supabase",
    category: "dev",
    label: "Supabase",
    description: "Supabase projects, database and functions.",
    icon: "supabase",
    serverUrl: "https://mcp.supabase.com/mcp",
  },
  {
    id: "supabase-readonly",
    category: "dev",
    label: "Supabase",
    description: "Read-only queries on Supabase projects: SQL runs as a read-only Postgres user.",
    icon: "supabase",
    // Supabase enforces read_only on its side (SQL as a read-only Postgres user); `features` keeps only the
    // database, docs and debugging tools, so functions, storage, projects and account tools never show up.
    // Its OAuth screen still lists read + write scopes: Supabase requires all of them (documented).
    serverUrl: "https://mcp.supabase.com/mcp?read_only=true&features=database,docs,debugging",
    readTools: ["execute_sql"],
  },
  {
    id: "intercom",
    category: "support",
    label: "Intercom",
    description: "Intercom conversations and contacts (US accounts).",
    icon: "intercom",
    serverUrl: "https://mcp.intercom.com/mcp",
  },
  {
    id: "paypal",
    category: "payments",
    label: "PayPal",
    description: "PayPal orders, invoices and transactions.",
    icon: "paypal",
    serverUrl: "https://mcp.paypal.com/mcp",
  },
  {
    id: "square",
    category: "payments",
    label: "Square",
    description: "Square payments, orders and catalog.",
    icon: "square",
    serverUrl: "https://mcp.squareup.com/mcp",
  },
  {
    id: "webflow",
    category: "marketing",
    label: "Webflow",
    description: "Webflow sites, pages and CMS.",
    icon: "webflow",
    serverUrl: "https://mcp.webflow.com/mcp",
  },
  {
    id: "zapier",
    category: "automation",
    label: "Zapier",
    description: "The actions you enabled in Zapier MCP.",
    icon: "zapier",
    serverUrl: "https://mcp.zapier.com/api/mcp/mcp",
  },
  {
    id: "canva",
    category: "marketing",
    label: "Canva",
    description: "Canva designs and templates.",
    icon: "canva",
    serverUrl: "https://mcp.canva.com/mcp",
  },
];

export const mcpPreset = (id: string) => MCP_PRESETS.find((p) => p.id === id) ?? null;

/** The preset a connection came from (by its server URL), if any. */
export function presetForServer(serverUrl: string | null | undefined) {
  if (!serverUrl) return null;
  const url = canonicalResource(serverUrl);
  return MCP_PRESETS.find((p) => canonicalResource(p.serverUrl) === url) ?? null;
}
