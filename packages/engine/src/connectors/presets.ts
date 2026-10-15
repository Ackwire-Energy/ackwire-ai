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
  /** Icon name in the app's icon set (falls back to a generic plug). */
  icon: string;
  serverUrl: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "linear",
    label: "Linear",
    description: "Issues, projetos e ciclos do Linear.",
    icon: "linear",
    serverUrl: "https://mcp.linear.app/mcp",
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Erros, issues e releases do Sentry.",
    icon: "sentry",
    serverUrl: "https://mcp.sentry.dev/mcp",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Páginas e bases de dados do Notion.",
    icon: "notion",
    serverUrl: "https://mcp.notion.com/mcp",
  },
  {
    id: "atlassian",
    label: "Atlassian (Jira e Confluence)",
    description: "Issues do Jira e páginas do Confluence.",
    icon: "atlassian",
    serverUrl: "https://mcp.atlassian.com/v1/mcp",
  },
  {
    id: "asana",
    label: "Asana",
    description: "Tarefas, projetos e times do Asana.",
    icon: "asana",
    serverUrl: "https://mcp.asana.com/mcp",
  },
  {
    id: "stripe",
    label: "Stripe",
    description: "Clientes, pagamentos, assinaturas e faturas do Stripe.",
    icon: "stripe",
    serverUrl: "https://mcp.stripe.com",
  },
  {
    id: "cloudflare-bindings",
    label: "Cloudflare (Workers)",
    description: "Workers, KV, R2 e D1 da conta Cloudflare.",
    icon: "cloudflare",
    serverUrl: "https://bindings.mcp.cloudflare.com/mcp",
  },
  {
    id: "cloudflare-observability",
    label: "Cloudflare (logs)",
    description: "Logs e métricas dos Workers.",
    icon: "cloudflare",
    serverUrl: "https://observability.mcp.cloudflare.com/mcp",
  },
  {
    id: "supabase",
    label: "Supabase",
    description: "Projetos, banco de dados e funções do Supabase.",
    icon: "supabase",
    serverUrl: "https://mcp.supabase.com/mcp",
  },
  {
    id: "intercom",
    label: "Intercom",
    description: "Conversas e contatos do Intercom (contas nos EUA).",
    icon: "intercom",
    serverUrl: "https://mcp.intercom.com/mcp",
  },
  {
    id: "paypal",
    label: "PayPal",
    description: "Pedidos, faturas e transações do PayPal.",
    icon: "paypal",
    serverUrl: "https://mcp.paypal.com/mcp",
  },
  {
    id: "square",
    label: "Square",
    description: "Pagamentos, pedidos e catálogo do Square.",
    icon: "square",
    serverUrl: "https://mcp.squareup.com/mcp",
  },
  {
    id: "webflow",
    label: "Webflow",
    description: "Sites, páginas e CMS do Webflow.",
    icon: "webflow",
    serverUrl: "https://mcp.webflow.com/mcp",
  },
  {
    id: "zapier",
    label: "Zapier",
    description: "As ações que você liberou no Zapier MCP.",
    icon: "zapier",
    serverUrl: "https://mcp.zapier.com/api/mcp/mcp",
  },
  {
    id: "canva",
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
