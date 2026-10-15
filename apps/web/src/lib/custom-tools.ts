import type { CustomServer, CustomTool, ToolAccess } from "@/api/types";

/**
 * Classification of a custom MCP server's tools. Tools the server marks
 * read-only start as "Leitura"; everything else starts as "Sempre pede
 * aprovação". Nothing is exposed until an admin saves; tools that appear
 * later stay hidden until classified.
 */

export const defaultAccess = (tool: Pick<CustomTool, "readOnlyHint">): ToolAccess =>
  tool.readOnlyHint === true ? "read" : "approval";

/** The backend's suggestion for every tool, when it sends one (else null: hide "Aceitar sugestão"). */
export function suggestion(server: CustomServer): Record<string, ToolAccess> | null {
  const out: Record<string, ToolAccess> = {};
  for (const t of server.tools) if (t.suggestedAccess) out[t.name] = t.suggestedAccess;
  return Object.keys(out).length > 0 ? out : null;
}

/** `list_tickets` → `List tickets` (starting point for the pt-BR label). */
export const humanize = (name: string) => {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface ToolDraft {
  name: string;
  description: string;
  access: ToolAccess;
  label: string;
  /** Appeared after the last review. */
  isNew: boolean;
}

export function draftFrom(server: CustomServer): ToolDraft[] {
  return server.tools.map((t) => ({
    name: t.name,
    description: t.description,
    access: t.access ?? defaultAccess(t),
    label: t.label || humanize(t.name),
    isNew: t.access === null && server.reviewedAt !== null,
  }));
}

/** Tools waiting for a decision ("N ferramentas novas para revisar"). */
export const toolsToReview = (server: CustomServer) => server.tools.filter((t) => t.access === null).length;

/** What agents can see: classified tools of a reviewed server. */
export const exposedTools = (server: CustomServer) =>
  server.reviewedAt ? server.tools.filter((t) => t.access !== null) : [];

export function searchDrafts(drafts: ToolDraft[], query: string) {
  const q = query.trim().toLowerCase();
  return q ? drafts.filter((d) => `${d.name} ${d.label} ${d.description}`.toLowerCase().includes(q)) : drafts;
}

export const isHttpsUrl = (v: string) => /^https:\/\/[^\s/]+/.test(v.trim());
