import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

/** A signed-up person outside the organization (sign-up is open on this server). */
async function outsider(email: string) {
  const b = browser(t);
  await signUp(b, email);
  return b;
}

type Page = { id: string; slug: string; version: number; backlinks: { kind: string }[]; body: string };

test("wiki API: create, edit with version check, rename, history, graph, links in messages", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/wiki/pages", {
    json: { title: "Guia de Deploy", folder: "Processos", body: "## Rollback\nx" },
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ slug: "guia-de-deploy", folder: "Processos", version: 1 });
  const dup = await api("/wiki/pages", { json: { title: "guia de deploy", body: "" } });
  expect(dup.status).toBe(409);
  expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("slug_taken");

  const saved = await api("/wiki/pages/guia-de-deploy", {
    method: "PUT",
    json: { body: "## Rollback\ny", baseVersion: 1, note: "corrigi" },
  });
  expect(((await saved.json()) as Page).version).toBe(2);
  const stale = await api("/wiki/pages/guia-de-deploy", { method: "PUT", json: { body: "z", baseVersion: 1 } });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("version_conflict");

  await api("/wiki/pages", { json: { title: "Runbook", body: "Veja [[Guia de Deploy#Rollback]]" } });
  const posted = await api(`/channels/${channelId}/messages`, { json: { body: "olha o [[Guia de Deploy]]" } });
  const message = (await posted.json()) as { id: string; meta: { wikiLinks?: { slug: string; exists: boolean }[] } };
  expect(message.meta.wikiLinks).toEqual([expect.objectContaining({ slug: "guia-de-deploy", exists: true })]);
  const listed = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; meta: { wikiLinks?: unknown[] } }[];
  };
  expect(listed.messages.find((m) => m.id === message.id)?.meta.wikiLinks).toHaveLength(1);

  const renamed = await api("/wiki/pages/guia-de-deploy/rename", { json: { title: "Publicação" } });
  expect(await renamed.json()).toMatchObject({ slug: "publicacao" });
  const runbook = (await (await api("/wiki/pages/runbook")).json()) as Page;
  expect(runbook.body).toBe("Veja [[Publicação#Rollback]]");
  const page = (await (await api("/wiki/pages/guia-de-deploy")).json()) as Page;
  expect(page.slug).toBe("publicacao");
  expect(page.backlinks.map((b) => b.kind).sort()).toEqual(["message", "page"]);

  const history = (await (await api("/wiki/pages/publicacao/history")).json()) as { versions: { version: number }[] };
  expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1]);
  expect(await (await api("/wiki/pages/publicacao/versions/1")).json()).toMatchObject({
    version: 1,
    body: "## Rollback\nx",
  });
  const diff = (await (await api("/wiki/pages/publicacao/diff?from=1&to=2")).json()) as { patch: string };
  expect(diff.patch).toContain("+y");
  expect(await (await api("/wiki/graph")).json()).toMatchObject({ edges: [{ from: "runbook", to: "publicacao" }] });
  const search = (await (await api("/wiki/search?q=pub")).json()) as { pages: { slug: string }[] };
  expect(search.pages.map((p) => p.slug)).toEqual(["publicacao"]);
  const all = (await (await api("/wiki/pages")).json()) as { pages: unknown[] };
  expect(all.pages).toHaveLength(2);
  const resolved = (await (await api("/wiki/resolve", { json: { targets: ["Publicação", "Nada"] } })).json()) as {
    links: { exists: boolean }[];
  };
  expect(resolved.links.map((l) => l.exists)).toEqual([true, false]);

  const append = await api("/wiki/pages/publicacao/append", {
    json: { source: { kind: "message", channelId, messageId: message.id } },
  });
  expect(((await append.json()) as Page).body).toContain("olha o [[Guia de Deploy]]");

  expect((await api("/wiki/pages/runbook", { method: "DELETE" })).status).toBe(204);
  expect((await api("/wiki/pages/runbook")).status).toBe(404);
  expect((await api("/wiki/pages/runbook/restore", { json: {} })).status).toBe(200);

  const stranger = await outsider("stranger@example.com");
  expect((await stranger(`/api/app/organizations/${orgId}/wiki/pages`)).status).toBe(403);
});

test("wiki API: Obsidian import in batches, pin, what the agents read", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const imported = await api("/wiki/import", {
    json: {
      source: { type: "obsidian", name: "Acme Vault" },
      onConflict: "keep_both",
      folder: "Obsidian",
      notes: [
        { title: "Início", body: "Veja [[Mercado Bom]].", tags: ["mapa"], aliases: ["Home"] },
        { title: "Mercado Bom", folder: "Clientes", body: "Volta ao [[Home]]." },
      ],
    },
  });
  expect(imported.status).toBe(200);
  const result = (await imported.json()) as { created: { slug: string; folder: string; sourceType: string }[] };
  expect(result.created).toMatchObject([
    { slug: "inicio", folder: "Obsidian", sourceType: "obsidian" },
    { slug: "mercado-bom", folder: "Obsidian/Clientes", sourceType: "obsidian" },
  ]);
  const home = (await (await api("/wiki/pages/home")).json()) as Page & { reads: unknown };
  expect(home.slug).toBe("inicio");
  expect(home.backlinks).toMatchObject([{ kind: "page", slug: "mercado-bom" }]);
  expect(home.reads).toEqual({ total: 0, agents: [], last: null });
  const graph = (await (await api("/wiki/graph")).json()) as { nodes: { sourceType: string | null }[] };
  expect(graph.nodes.every((n) => n.sourceType === "obsidian")).toBe(true);

  const pinned = await api("/wiki/pages/inicio/pin", { json: { pinned: true } });
  expect(((await pinned.json()) as { pinned: boolean }).pinned).toBe(true);
  expect(await (await api("/wiki/reads")).json()).toEqual([]);

  const tooMany = await api("/wiki/import", {
    json: {
      source: { type: "obsidian", name: "x" },
      notes: Array.from({ length: 501 }, (_, i) => ({ title: `N${i}`, body: "" })),
    },
  });
  expect(tooMany.status).toBe(400);
});
