import type { ConnectorCategory } from "./catalog";
import { canonicalResource } from "./oauth-mcp";

/**
 * One-click connectors: vendors' official remote MCP servers that speak MCP
 * OAuth with Dynamic Client Registration (no app of ours to register). Each
 * was checked (2026-10-15, and 2026-10-28 from GitLab on): the server
 * answers 401 with OAuth, its authorization server publishes a
 * `registration_endpoint` and PKCE S256.
 * They connect like any custom MCP server; after the OAuth, our suggested
 * classification (read tools free, writes approved, destructive ones need
 * approval) is applied at once, and admins can change it.
 *
 * Left out: HubSpot (its authorization server has no dynamic registration:
 * it needs an app registered with HubSpot); Vercel (only clients Vercel
 * reviewed and approved may connect). Slack, Zendesk, Box, Render,
 * PagerDuty, Front, Pipedrive, Shopify and Microsoft 365 also need an app
 * registered with them; Figma's server registers clients but only lets
 * approved ones through.
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
  {
    id: "gitlab",
    category: "dev",
    label: "GitLab",
    description: "GitLab.com projects, merge requests, issues and pipelines.",
    icon: "gitlab",
    serverUrl: "https://gitlab.com/api/v4/mcp",
  },
  {
    id: "neon",
    category: "dev",
    label: "Neon",
    description: "Neon Postgres projects, branches and queries.",
    icon: "neon",
    serverUrl: "https://mcp.neon.tech/mcp",
  },
  {
    id: "prisma",
    category: "dev",
    label: "Prisma",
    description: "Prisma Postgres databases, backups and queries.",
    icon: "prisma",
    serverUrl: "https://mcp.prisma.io/mcp",
  },
  {
    id: "netlify",
    category: "dev",
    label: "Netlify",
    description: "Netlify sites, deploys and settings.",
    icon: "netlify",
    serverUrl: "https://netlify-mcp.netlify.app/mcp",
  },
  {
    id: "railway",
    category: "dev",
    label: "Railway",
    description: "Railway projects, services, deploys and logs.",
    icon: "railway",
    serverUrl: "https://mcp.railway.com",
  },
  {
    id: "datadog",
    category: "dev",
    label: "Datadog",
    description: "Datadog logs, metrics, monitors and incidents (US1 site).",
    icon: "datadog",
    serverUrl: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  },
  {
    id: "grafana",
    category: "dev",
    label: "Grafana",
    description: "Grafana Cloud dashboards, metrics, logs and alerts.",
    icon: "grafana",
    serverUrl: "https://mcp.grafana.com/mcp",
  },
  {
    id: "postman",
    category: "dev",
    label: "Postman",
    description: "Postman workspaces, collections and APIs.",
    icon: "postman",
    serverUrl: "https://mcp.postman.com/mcp",
  },
  {
    id: "jam",
    category: "dev",
    label: "Jam",
    description: "Jam bug reports: recordings, console logs and network requests.",
    icon: "jam",
    serverUrl: "https://mcp.jam.dev/mcp",
  },
  {
    id: "resend",
    category: "dev",
    label: "Resend",
    description: "Resend emails, domains and audiences.",
    icon: "resend",
    serverUrl: "https://mcp.resend.com/mcp",
  },
  {
    id: "expo",
    category: "dev",
    label: "Expo",
    description: "Expo projects, builds, updates and app store submissions.",
    icon: "expo",
    serverUrl: "https://mcp.expo.dev/mcp",
  },
  {
    id: "monday",
    category: "product",
    label: "monday.com",
    description: "monday.com boards, items and updates.",
    icon: "monday",
    serverUrl: "https://mcp.monday.com/mcp",
  },
  {
    id: "clickup",
    category: "product",
    label: "ClickUp",
    description: "ClickUp tasks, lists and docs.",
    icon: "clickup",
    serverUrl: "https://mcp.clickup.com/mcp",
  },
  {
    id: "todoist",
    category: "product",
    label: "Todoist",
    description: "Todoist tasks and projects.",
    icon: "todoist",
    serverUrl: "https://ai.todoist.net/mcp",
  },
  {
    id: "airtable",
    category: "docs",
    label: "Airtable",
    description: "Airtable bases, tables and records.",
    icon: "airtable",
    serverUrl: "https://mcp.airtable.com/mcp",
  },
  {
    id: "dropbox",
    category: "docs",
    label: "Dropbox",
    description: "Dropbox files and folders.",
    icon: "dropbox",
    serverUrl: "https://mcp.dropbox.com/mcp",
  },
  {
    id: "miro",
    category: "docs",
    label: "Miro",
    description: "Miro boards: read them and add content.",
    icon: "miro",
    serverUrl: "https://mcp.miro.com/",
  },
  {
    id: "gamma",
    category: "docs",
    label: "Gamma",
    description: "Gamma presentations, documents and sites.",
    icon: "gamma",
    serverUrl: "https://mcp.gamma.app/mcp",
  },
  {
    id: "granola",
    category: "docs",
    label: "Granola",
    description: "Granola meeting notes and transcripts.",
    icon: "granola",
    serverUrl: "https://mcp.granola.ai/mcp",
  },
  {
    id: "fireflies",
    category: "docs",
    label: "Fireflies",
    description: "Fireflies meeting transcripts and summaries.",
    icon: "fireflies",
    serverUrl: "https://api.fireflies.ai/mcp",
  },
  {
    id: "mercadopago",
    category: "payments",
    label: "Mercado Pago",
    description: "Mercado Pago payments, documentation and integration checks.",
    icon: "mercadopago",
    serverUrl: "https://mcp.mercadopago.com/mcp",
  },
  {
    id: "revenuecat",
    category: "payments",
    label: "RevenueCat",
    description: "RevenueCat in-app subscriptions, products, offerings and revenue.",
    icon: "revenuecat",
    serverUrl: "https://mcp.revenuecat.ai/mcp",
  },
  {
    id: "superwall",
    category: "payments",
    label: "Superwall",
    description: "Superwall paywalls, campaigns and experiments.",
    icon: "superwall",
    serverUrl: "https://mcp.superwall.com/mcp",
  },
  {
    id: "paddle",
    category: "payments",
    label: "Paddle",
    description: "Paddle customers, subscriptions, transactions and products.",
    icon: "paddle",
    serverUrl: "https://mcp.paddle.com/mcp",
  },
  {
    id: "abacatepay",
    category: "payments",
    label: "AbacatePay",
    description: "AbacatePay Pix charges, customers and withdrawals.",
    icon: "abacatepay",
    serverUrl: "https://mcp.abacatepay.com/mcp",
  },
  {
    id: "attio",
    category: "sales",
    label: "Attio",
    description: "Attio CRM records, lists and notes.",
    icon: "attio",
    serverUrl: "https://mcp.attio.com/mcp",
  },
  {
    id: "close",
    category: "sales",
    label: "Close",
    description: "Close CRM leads, opportunities and activities.",
    icon: "close",
    serverUrl: "https://mcp.close.com/mcp",
  },
  {
    id: "calendly",
    category: "sales",
    label: "Calendly",
    description: "Calendly events, event types and availability.",
    icon: "calendly",
    serverUrl: "https://mcp.calendly.com",
  },
  {
    id: "posthog",
    category: "data",
    label: "PostHog",
    description: "PostHog insights, feature flags, experiments and errors.",
    icon: "posthog",
    serverUrl: "https://mcp.posthog.com/mcp",
  },
  {
    id: "mixpanel",
    category: "data",
    label: "Mixpanel",
    description: "Mixpanel events, reports and funnels.",
    icon: "mixpanel",
    serverUrl: "https://mcp.mixpanel.com/mcp",
  },
  {
    id: "amplitude",
    category: "data",
    label: "Amplitude",
    description: "Amplitude charts, dashboards and experiments.",
    icon: "amplitude",
    serverUrl: "https://mcp.amplitude.com/mcp",
  },
  {
    id: "himetrica",
    category: "data",
    label: "Himetrica",
    description: "Himetrica visitors, funnels, revenue and search traffic.",
    icon: "himetrica",
    serverUrl: "https://app.himetrica.com/api/v1/mcp",
  },
  {
    id: "meta-ads",
    category: "marketing",
    label: "Meta Ads",
    description: "Meta (Facebook and Instagram) ad campaigns and results.",
    icon: "meta",
    serverUrl: "https://mcp.facebook.com/ads",
  },
  {
    id: "klaviyo",
    category: "marketing",
    label: "Klaviyo",
    description: "Klaviyo campaigns, flows, lists and profiles.",
    icon: "klaviyo",
    serverUrl: "https://mcp.klaviyo.com/mcp",
  },
  {
    id: "millionsend",
    category: "marketing",
    label: "MillionSend",
    description: "MillionSend email campaigns, lists and contacts.",
    icon: "millionsend",
    serverUrl: "https://api.millionsend.com/mcp",
  },
  {
    id: "semrush",
    category: "marketing",
    label: "Semrush",
    description: "Semrush keyword, domain and backlink data.",
    icon: "semrush",
    serverUrl: "https://mcp.semrush.com/v1/mcp",
  },
  {
    id: "ahrefs",
    category: "marketing",
    label: "Ahrefs",
    description: "Ahrefs keyword, backlink and site data.",
    icon: "ahrefs",
    serverUrl: "https://api.ahrefs.com/mcp/mcp",
  },
  {
    id: "wix",
    category: "marketing",
    label: "Wix",
    description: "Wix sites, CMS, stores and bookings.",
    icon: "wix",
    serverUrl: "https://mcp.wix.com/mcp",
  },
  {
    id: "sanity",
    category: "marketing",
    label: "Sanity",
    description: "Sanity content, schemas and releases.",
    icon: "sanity",
    serverUrl: "https://mcp.sanity.io",
  },
  {
    id: "contentful",
    category: "marketing",
    label: "Contentful",
    description: "Contentful entries, content types and assets.",
    icon: "contentful",
    serverUrl: "https://mcp.contentful.com/mcp",
  },
  {
    id: "jotform",
    category: "marketing",
    label: "Jotform",
    description: "Jotform forms and submissions.",
    icon: "jotform",
    serverUrl: "https://mcp.jotform.com/",
  },
  {
    id: "tally",
    category: "marketing",
    label: "Tally",
    description: "Tally forms and responses.",
    icon: "tally",
    serverUrl: "https://api.tally.so/mcp",
  },
];

export const mcpPreset = (id: string) => MCP_PRESETS.find((p) => p.id === id) ?? null;

/** The preset a connection came from (by its server URL), if any. */
export function presetForServer(serverUrl: string | null | undefined) {
  if (!serverUrl) return null;
  const url = canonicalResource(serverUrl);
  return MCP_PRESETS.find((p) => canonicalResource(p.serverUrl) === url) ?? null;
}
