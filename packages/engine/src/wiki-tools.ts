import { and, eq, schema } from "@agenteschat/db";
import { type ActionRecord, actWithUndo } from "./agent-actions";
import { cutText } from "./format";
import { personBehindCall, wikiActorOfCall } from "./requester";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import {
  appendToWikiPage,
  createWikiPage,
  getWikiPage,
  recordWikiReads,
  searchWiki,
  updateWikiPage,
  type WikiActor,
  type WikiDeps,
} from "./wiki";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** Shown when an agent tries to write without being asked. */
export const WIKI_WRITE_REFUSAL =
  'Not allowed: write to the wiki only when a person asks in the current message ("save this to the wiki", "document…"; in Portuguese "salva isso na wiki", "documenta…"). Offer to save it instead.';

/**
 * Who asked: the person behind the run (`authority.ts`). Forum turns, routines and agents' own
 * messages are nobody's request, so agents can't write the wiki on their own there.
 */
async function requester(ctx: ToolContext): Promise<string | null> {
  const [m] = await ctx.db
    .select({ meta: schema.messages.meta })
    .from(schema.messages)
    .where(and(eq(schema.messages.id, ctx.triggerMessageId), eq(schema.messages.orgId, ctx.orgId)));
  const forum = (m?.meta as { forum?: { kickoff?: boolean } } | undefined)?.forum;
  if (forum?.kickoff) return null;
  return personBehindCall(ctx);
}

/**
 * The receipt of a wiki edit (none when the text came out the same). Everyone in the channel sees it, so a restricted
 * page goes without its title or slug.
 */
const wikiEdit = (
  p: { id: string; title: string; slug: string; version: number; audience: unknown },
  before: number,
): ActionRecord | null =>
  p.version === before
    ? null
    : {
        kind: "wiki.page_edited" as const,
        target: p.audience
          ? { type: "wiki_page" as const, id: p.id }
          : { type: "wiki_page" as const, id: p.id, title: p.title, slug: p.slug },
        params: p.audience ? { restricted: true } : { title: p.title, slug: p.slug },
        before: { version: before },
        after: { version: p.version },
      };

/**
 * The org wiki for agents (ADR 0023): `search_wiki` and `read_wiki_page`
 * (`wiki:read`), `create_wiki_page`, `update_wiki_page` and `link_to_wiki`
 * (`wiki:write`). Writes need a person's request in the trigger message, and
 * every version records "by {agent}, at {person}'s request".
 */
export function createWikiToolSource(deps: Omit<WikiDeps, "db">): ToolSource {
  const wiki = (ctx: ToolContext): WikiDeps => ({ ...deps, db: ctx.db });
  const pageRef = { type: "string", minLength: 1, maxLength: 200, description: "Page title or slug" };

  async function writer(ctx: ToolContext): Promise<WikiActor | null> {
    const userId = await requester(ctx);
    return userId ? { type: "agent", agentId: ctx.agentId, requestedByUserId: userId, channelId: ctx.channelId } : null;
  }

  const tools: ToolDefinition[] = [
    {
      name: "search_wiki",
      description:
        "Search the organization's wiki (the team's documented knowledge: processes, decisions, guides). Returns pages with their [[link]] to cite.",
      scope: "wiki:read",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 300 } },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const pages = await searchWiki(wiki(ctx), await wikiActorOfCall(ctx), ctx.orgId, str(input.query), 8);
          if (pages.length === 0) return { content: "No wiki pages match." };
          return {
            content: pages
              .map(
                (p) =>
                  `- [[${p.title}]] (${p.folder ? `${p.folder}/` : ""}${p.slug}, v${p.version}): ${cutText(p.body.replace(/\s+/g, " "), 200)}`,
              )
              .join("\n"),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "read_wiki_page",
      description: "Read a wiki page in full (by title or slug), with its version and what links to it.",
      scope: "wiki:read",
      inputSchema: {
        type: "object",
        properties: { page: pageRef },
        required: ["page"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const p = await getWikiPage(ctx.db, await wikiActorOfCall(ctx), ctx.orgId, str(input.page));
          await recordWikiReads(ctx.db, {
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            runId: ctx.runId,
            channelId: ctx.channelId,
            pageIds: [p.id],
          });
          const backlinks = p.backlinks.filter((b) => b.kind === "page").map((b) => `[[${b.title}]]`);
          return {
            content: [
              `# ${p.title} (slug ${p.slug}, version ${p.version}${p.folder ? `, folder ${p.folder}` : ""}${p.locked ? ", locked" : ""}${p.canEdit ? "" : ", read-only for you"})`,
              p.tags.length ? `Tags: ${p.tags.join(", ")}` : "",
              cutText(p.body, 40_000),
              backlinks.length ? `Linked from: ${backlinks.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "create_wiki_page",
      description:
        "Create a wiki page. ONLY when a person asks you to save or document something in the wiki in the current message; never on your own. Use [[Title]] to link other pages.",
      scope: "wiki:write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          body: { type: "string", maxLength: 200_000, description: "Markdown" },
          folder: { type: "string", maxLength: 200, description: 'e.g. "Engenharia/Backend"' },
          tags: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 20 },
          note: { type: "string", maxLength: 300, description: "What and why (shown in the history)" },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const actor = await writer(ctx);
        if (!actor) return { content: WIKI_WRITE_REFUSAL, isError: true };
        try {
          const p = await actWithUndo(
            ctx,
            (db) =>
              createWikiPage({ ...wiki(ctx), db }, actor, ctx.orgId, {
                title: str(input.title),
                body: str(input.body),
                folder: str(input.folder) || undefined,
                tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
                note: str(input.note) || undefined,
              }),
            (page) => ({
              kind: "wiki.page_created",
              target: { type: "wiki_page", id: page.id, title: page.title, slug: page.slug },
              params: { title: page.title, slug: page.slug },
              after: { version: page.version },
            }),
          );
          return {
            content: `Created [[${p.title}]] (slug ${p.slug}, version 1). Link it in your reply as [[${p.title}]].`,
            data: { wikiPageId: p.id, slug: p.slug },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "update_wiki_page",
      description:
        "Change a wiki page: append text (at the end or to a section) or rewrite one section (`replace_section`), or the whole page (`replace`, needs `base_version` from read_wiki_page). ONLY when a person asks in the current message.",
      scope: "wiki:write",
      inputSchema: {
        type: "object",
        properties: {
          page: pageRef,
          mode: { enum: ["append", "replace_section", "replace"] },
          content: { type: "string", minLength: 1, maxLength: 200_000, description: "Markdown" },
          section: { type: "string", maxLength: 200, description: "Heading text (without #)" },
          base_version: { type: "integer", minimum: 1 },
          note: { type: "string", maxLength: 300 },
        },
        required: ["page", "mode", "content"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const actor = await writer(ctx);
        if (!actor) return { content: WIKI_WRITE_REFUSAL, isError: true };
        try {
          const mode = str(input.mode);
          const page = str(input.page);
          if (mode === "replace" && typeof input.base_version !== "number") {
            return { content: "Read the page first and pass its version as base_version.", isError: true };
          }
          if (mode === "replace_section" && !str(input.section)) {
            return { content: "replace_section needs `section`.", isError: true };
          }
          let before = 0;
          const p = await actWithUndo(
            ctx,
            async (db) => {
              const deps = { ...wiki(ctx), db };
              before = (await getWikiPage(db, actor, ctx.orgId, page)).version;
              return mode === "replace"
                ? updateWikiPage(deps, actor, ctx.orgId, page, {
                    baseVersion: input.base_version as number,
                    body: str(input.content),
                    note: str(input.note) || undefined,
                  })
                : appendToWikiPage(deps, actor, ctx.orgId, page, {
                    text: str(input.content),
                    section: str(input.section) || null,
                    mode: mode === "replace_section" ? "replace_section" : "append",
                    note: str(input.note) || undefined,
                  });
            },
            (saved) => wikiEdit(saved, before),
          );
          return {
            content: `Saved [[${p.title}]] as version ${p.version}.`,
            data: { wikiPageId: p.id, slug: p.slug, version: p.version },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "link_to_wiki",
      description:
        'Add links from one wiki page to others (in its "See also" section, or `section`: name it in the page\'s language, e.g. "Veja também"). ONLY when a person asks.',
      scope: "wiki:write",
      inputSchema: {
        type: "object",
        properties: {
          page: pageRef,
          to: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 20 },
          section: { type: "string", maxLength: 200 },
        },
        required: ["page", "to"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const actor = await writer(ctx);
        if (!actor) return { content: WIKI_WRITE_REFUSAL, isError: true };
        try {
          const targets = (input.to as string[]).map((t) => t.replace(/[[\]]/g, "").trim()).filter(Boolean);
          let before = 0;
          const p = await actWithUndo(
            ctx,
            async (db) => {
              before = (await getWikiPage(db, actor, ctx.orgId, str(input.page))).version;
              return appendToWikiPage({ ...wiki(ctx), db }, actor, ctx.orgId, str(input.page), {
                text: targets.map((t) => `- [[${t}]]`).join("\n"),
                section: str(input.section) || "See also",
              });
            },
            (saved) => wikiEdit(saved, before),
          );
          return { content: `Linked [[${p.title}]] to ${targets.map((t) => `[[${t}]]`).join(", ")}.` };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "wiki", tools: async () => tools };
}
