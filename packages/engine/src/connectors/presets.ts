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
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Icon name in the app's icon set (falls back to a generic plug). */
  icon: string;
  serverUrl: string;
  /**
   * The server itself only reads (e.g. Supabase's `read_only=true`: SQL runs as
   * a read-only Postgres user and the writing tools are off), so every tool is
   * suggested as read.
   */
  readOnly?: boolean;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "linear",
    category: "product",
    label: "Linear",
    description: "Issues, projetos e ciclos do Linear.",
    icon: "linear",
    serverUrl: "https://mcp.linear.app/mcp",
  },
  {
    id: "sentry",
    category: "dev",
    label: "Sentry",
    description: "Erros, issues e releases do Sentry.",
    icon: "sentry",
    serverUrl: "https://mcp.sentry.dev/mcp",
  },
  {
    id: "notion",
    category: "docs",
    label: "Notion",
    description: "Páginas e bases de dados do Notion.",
    icon: "notion",
    serverUrl: "https://mcp.notion.com/mcp",
  },
  {
    id: "atlassian",
    category: "product",
    label: "Atlassian (Jira e Confluence)",
    description: "Issues do Jira e páginas do Confluence.",
    icon: "atlassian",
    serverUrl: "https://mcp.atlassian.com/v1/mcp",
  },
  {
    id: "asana",
    category: "product",
    label: "Asana",
    description: "Tarefas, projetos e times do Asana.",
    icon: "asana",
    serverUrl: "https://mcp.asana.com/mcp",
  },
  {
    id: "stripe",
    category: "payments",
    label: "Stripe",
    description: "Clientes, pagamentos, assinaturas e faturas do Stripe.",
    icon: "stripe",
    serverUrl: "https://mcp.stripe.com",
  },
  {
    id: "cloudflare-bindings",
    category: "dev",
    label: "Cloudflare (Workers)",
    description: "Workers, KV, R2 e D1 da conta Cloudflare.",
    icon: "cloudflare",
    serverUrl: "https://bindings.mcp.cloudflare.com/mcp",
  },
  {
    id: "cloudflare-observability",
    category: "dev",
    label: "Cloudflare (logs)",
    description: "Logs e métricas dos Workers.",
    icon: "cloudflare",
    serverUrl: "https://observability.mcp.cloudflare.com/mcp",
  },
  {
    id: "supabase",
    category: "dev",
    label: "Supabase",
    description: "Projetos, banco de dados e funções do Supabase.",
    icon: "supabase",
    serverUrl: "https://mcp.supabase.com/mcp",
  },
  {
    id: "supabase-readonly",
    category: "dev",
    label: "Supabase (somente leitura)",
    description: "Consultas e leitura dos projetos do Supabase; o próprio Supabase bloqueia qualquer escrita.",
    icon: "supabase",
    serverUrl: "https://mcp.supabase.com/mcp?read_only=true",
    readOnly: true,
  },
  {
    id: "intercom",
    category: "support",
    label: "Intercom",
    description: "Conversas e contatos do Intercom (contas nos EUA).",
    icon: "intercom",
    serverUrl: "https://mcp.intercom.com/mcp",
  },
  {
    id: "paypal",
    category: "payments",
    label: "PayPal",
    description: "Pedidos, faturas e transações do PayPal.",
    icon: "paypal",
    serverUrl: "https://mcp.paypal.com/mcp",
  },
  {
    id: "square",
    category: "payments",
    label: "Square",
    description: "Pagamentos, pedidos e catálogo do Square.",
    icon: "square",
    serverUrl: "https://mcp.squareup.com/mcp",
  },
  {
    id: "webflow",
    category: "marketing",
    label: "Webflow",
    description: "Sites, páginas e CMS do Webflow.",
    icon: "webflow",
    serverUrl: "https://mcp.webflow.com/mcp",
  },
  {
    id: "zapier",
    category: "automation",
    label: "Zapier",
    description: "As ações que você liberou no Zapier MCP.",
    icon: "zapier",
    serverUrl: "https://mcp.zapier.com/api/mcp/mcp",
  },
  {
    id: "canva",
    category: "marketing",
    label: "Canva",
    description: "Designs e modelos do Canva.",
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
