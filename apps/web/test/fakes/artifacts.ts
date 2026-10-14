/**
 * Test fake — artifacts (documents, tables, diffs, diagrams, HTML pages).
 * Mirrors these endpoints (shapes in `api/types.ts`):
 * - `GET    /api/app/organizations/{orgId}/artifacts?q&kind&channelId&authorType&authorId` → Artifact[] (newest update first)
 * - `GET    …/artifacts/{id}?version=` → ArtifactDetail (content of that version)
 * - `GET    …/artifacts/{id}/versions` → ArtifactVersion[] (newest first)
 * - `GET    …/artifacts/{id}/download?version=` → `{ url, expiresAt }` (signed URL)
 * - `POST   …/artifacts` `{ title, channelId?, content }`, `PATCH …/artifacts/{id}` `{ content, note?, baseVersion }` (409 when stale), `DELETE …/artifacts/{id}`
 * - channel events `artifact.created` / `artifact.updated` `{ artifact }`, and `meta.artifacts: [{ id, version }]` on agent messages.
 * Seeded in development only; lost on reload.
 */
import type { ApiClient } from "@/api/client";
import type { Artifact, ArtifactAuthor, ArtifactContent, ArtifactDetail, ArtifactVersion } from "@/api/types";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

interface Stored {
  meta: Omit<Artifact, "canEdit" | "untrusted">;
  versions: (ArtifactVersion & { content: ArtifactContent })[];
}

class MockConflictError extends Error {
  readonly status = 409;
  readonly code = "stale_version";
}

const editable = (kind: Artifact["kind"]) => kind === "document" || kind === "table";

export function serializeContent(content: ArtifactContent): { text: string; type: string } {
  switch (content.kind) {
    case "document":
      return { text: content.markdown, type: "text/markdown" };
    case "table": {
      const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
      return { text: [content.columns, ...content.rows].map((r) => r.map(q).join(",")).join("\n"), type: "text/csv" };
    }
    case "diff":
      return {
        text: content.files.map((f) => `--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`).join("\n"),
        type: "text/x-diff",
      };
    case "diagram":
      return { text: content.mermaid, type: "text/plain" };
    case "html":
      return { text: content.html, type: "text/html" };
  }
}

export function createMockArtifacts(ctx: MockContext): ApiClient["artifacts"] {
  const store = perOrg(async (orgId) => {
    const list: Stored[] = [];
    if (!ctx.seed) return list;
    const [agents, channels] = await Promise.all([ctx.lookup.agents(orgId), ctx.lookup.channels(orgId)]);
    const me = await ctx.lookup.me();
    const agent = (i: number): ArtifactAuthor => ({
      type: "agent",
      id: agents[i % Math.max(agents.length, 1)]?.id ?? "agent",
    });
    const person: ArtifactAuthor = { type: "person", id: me?.user.id ?? "me" };
    const channel = channels[0]?.id ?? null;
    const now = ctx.now();
    for (const seed of seeds()) {
      const by = seed.byPerson ? person : agent(seed.agent);
      const versions = seed.versions.map((content, i) => ({
        version: i + 1,
        author: i === 0 ? agent(seed.agent) : by,
        note: seed.notes[i] ?? null,
        createdAt: minutesAgo(now, seed.age - i * 30),
        content,
      }));
      const last = versions[versions.length - 1] as Stored["versions"][number];
      list.push({
        meta: {
          id: mockId("art"),
          kind: last.content.kind,
          title: seed.title,
          version: last.version,
          channelId: channel,
          threadId: null,
          createdBy: agent(seed.agent),
          updatedBy: last.author,
          createdAt: (versions[0] as Stored["versions"][number]).createdAt,
          updatedAt: last.createdAt,
        },
        versions,
      });
    }
    return list;
  });
  const find = async (orgId: string, id: string) => {
    const s = (await store(orgId)).find((a) => a.meta.id === id);
    if (!s) throw new MockNotFoundError("Arquivo não encontrado.");
    return s;
  };
  const view = (s: Stored): Artifact => ({
    ...clone(s.meta),
    canEdit: editable(s.meta.kind),
    untrusted: s.meta.kind === "html",
  });
  const detail = (s: Stored, version?: number): ArtifactDetail => {
    const v = s.versions.find((x) => x.version === (version ?? s.meta.version));
    if (!v) throw new MockNotFoundError("Versão não encontrada.");
    return { ...view(s), shownVersion: v.version, content: clone(v.content) };
  };
  const me = async (): Promise<ArtifactAuthor> => ({ type: "person", id: (await ctx.lookup.me())?.user.id ?? "me" });
  return {
    list: async (orgId, filters = {}) => {
      const q = filters.q?.trim().toLowerCase();
      return (await store(orgId))
        .filter((s) => !filters.kind || s.meta.kind === filters.kind)
        .filter((s) => !filters.channelId || s.meta.channelId === filters.channelId)
        .filter(
          (s) =>
            !filters.author ||
            s.versions.some((v) => v.author.type === filters.author?.type && v.author.id === filters.author.id),
        )
        .filter((s) => !q || s.meta.title.toLowerCase().includes(q))
        .map(view)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get: async (orgId, id, version) => detail(await find(orgId, id), version),
    versions: async (orgId, id) => (await find(orgId, id)).versions.map(({ content: _c, ...v }) => clone(v)).reverse(),
    fileUrl: (orgId, id, options = {}) => {
      const params = new URLSearchParams();
      if (options.version) params.set("version", String(options.version));
      if (options.format) params.set("format", options.format);
      const qs = params.toString();
      return `/api/app/organizations/${orgId}/artifacts/${id}/file${qs ? `?${qs}` : ""}`;
    },
    download: async (orgId, id, version) => {
      const { text, type } = serializeContent(detail(await find(orgId, id), version).content);
      return {
        url: `data:${type};charset=utf-8,${encodeURIComponent(text)}`,
        expiresAt: new Date(ctx.now().getTime() + 5 * 60_000).toISOString(),
      };
    },
    create: async (orgId, input) => {
      const author = await me();
      const at = ctx.now().toISOString();
      const s: Stored = {
        meta: {
          id: mockId("art"),
          kind: input.content.kind,
          title: input.title,
          version: 1,
          channelId: input.channelId ?? null,
          threadId: null,
          createdBy: author,
          updatedBy: author,
          createdAt: at,
          updatedAt: at,
        },
        versions: [{ version: 1, author, note: null, createdAt: at, content: clone(input.content) }],
      };
      (await store(orgId)).push(s);
      return detail(s);
    },
    update: async (orgId, id, input) => {
      const s = await find(orgId, id);
      if (input.baseVersion !== s.meta.version) throw new MockConflictError("Alguém salvou uma versão nova antes.");
      if (input.content.kind !== s.meta.kind) throw new Error("O tipo do arquivo não muda.");
      const author = await me();
      const at = ctx.now().toISOString();
      const version = s.meta.version + 1;
      s.versions.push({
        version,
        author,
        note: input.note?.trim() || null,
        createdAt: at,
        content: clone(input.content),
      });
      Object.assign(s.meta, { version, updatedBy: author, updatedAt: at, title: input.title ?? s.meta.title });
      return detail(s);
    },
    remove: async (orgId, id) => {
      const list = await store(orgId);
      const i = list.findIndex((a) => a.meta.id === id);
      if (i < 0) throw new MockNotFoundError("Arquivo não encontrado.");
      list.splice(i, 1);
    },
  };
}

function seeds(): {
  title: string;
  agent: number;
  byPerson?: boolean;
  age: number;
  notes: (string | null)[];
  versions: ArtifactContent[];
}[] {
  const report = (extra: string) =>
    `# Incidente no checkout\n\nO erro \`TypeError\` em \`/api/checkout\` começou às 18:04, logo depois do último deploy.\n\n## O que aconteceu\n\n- 142 eventos desde ontem\n- Só afeta carrinhos vazios\n${extra}\n## Próximos passos\n\n1. Corrigir a validação do carrinho\n2. Adicionar um teste\n\n\`\`\`ts\nif (!cart.items.length) return empty();\n\`\`\`\n`;
  return [
    {
      title: "Relatório de incidente: checkout",
      agent: 1,
      byPerson: true,
      age: 180,
      notes: [null, "Acrescentei quem foi afetado."],
      versions: [
        { kind: "document", markdown: report("") },
        { kind: "document", markdown: report("- **38 clientes** tentaram pagar nesse período\n") },
      ],
    },
    {
      title: "Pedidos mais comuns nos reviews",
      agent: 2,
      age: 120,
      notes: [],
      versions: [
        {
          kind: "table",
          columns: ["Pedido", "Menções", "Nota média"],
          rows: [
            ["Modo offline", "31", "2,6"],
            ["Exportar em PDF", "18", "3,1"],
            ["Tema escuro", "12", "4,0"],
            ["Login com Google", "9", "3,8"],
          ],
        },
      ],
    },
    {
      title: "Corrige o checkout com carrinho vazio",
      agent: 0,
      age: 90,
      notes: [],
      versions: [
        {
          kind: "diff",
          files: [
            {
              path: "api/checkout.ts",
              patch:
                '@@ -10,6 +10,9 @@ export async function checkout(cart: Cart) {\n   const user = await currentUser();\n-  const total = cart.items.reduce(sum, 0);\n+  if (!cart.items.length) {\n+    return { ok: false, error: "empty_cart" };\n+  }\n+  const total = cart.items.reduce(sum, 0);\n   return charge(user, total);\n }\n',
            },
            {
              path: "api/checkout.test.ts",
              patch:
                '@@ -1,3 +1,7 @@\n import { checkout } from "./checkout";\n+\n+test("empty cart", async () => {\n+  expect(await checkout({ items: [] })).toEqual({ ok: false, error: "empty_cart" });\n+});\n',
            },
          ],
        },
      ],
    },
    {
      title: "Organograma do time",
      agent: 3,
      age: 60,
      notes: [],
      versions: [
        {
          kind: "diagram",
          mermaid:
            "flowchart TD\n  W[Walter] --> J[João]\n  W --> M[Mariana]\n  J --> A[Ada · agente]\n  J --> T[Atlas · agente]\n  W --> H[Theo · agente]\n  M --> L[Lia · agente]",
        },
      ],
    },
    {
      title: "Painel de erros da semana",
      agent: 1,
      age: 30,
      notes: [],
      versions: [
        {
          kind: "html",
          html: '<!doctype html><html><body style="font-family:sans-serif;padding:16px"><h1>Erros da semana</h1><p id="n">…</p><script>document.getElementById("n").textContent = "142 eventos, 3 issues abertas";</script></body></html>',
        },
      ],
    },
  ];
}
