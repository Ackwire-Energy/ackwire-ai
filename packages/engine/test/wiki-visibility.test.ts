import { afterEach, describe, expect, test } from "bun:test";
import {
  createWikiPage,
  drainOutbox,
  ForbiddenError,
  getWikiPage,
  listWikiPages,
  parseWikiLinks,
  recordWikiReads,
  resolveWikiTargets,
  retrieveWikiForRun,
  searchForUser,
  searchWiki,
  setWikiPageAudience,
  suggestWikiPages,
  topWikiReads,
  updateWikiPage,
  ValidationError,
  type WikiActor,
  wikiGraph,
  withWikiLinks,
} from "../src";
import { addMember, adminRoleId, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });

/** A workspace with an admin, a member, an open page linking to a page limited to agents and admins. */
async function restricted() {
  f = await setup();
  const deps = wikiDeps();
  const ana = await addMember(f.db, f.org.id, "admin", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const secret = await createWikiPage(deps, person(f.owner.id), f.org.id, {
    title: "Margens",
    body: "Margem mínima de 40% nos contratos. Veja [[Processos]].",
  });
  const open = await createWikiPage(deps, person(f.owner.id), f.org.id, {
    title: "Processos",
    body: "Como vendemos. As margens estão em [[Margens]].",
  });
  const view = await setWikiPageAudience(deps, ana.id, f.org.id, "margens", {
    roleIds: [await adminRoleId(f.db, f.org.id)],
    userIds: [],
  });
  await drainOutbox(f.db, f.handlers);
  return { deps, ana, bia, secret, open, view };
}

const code = (e: unknown) => (e as { code?: string }).code;

describe("restricted wiki pages", () => {
  test("the audience and agents read it; anyone else gets a plain no access", async () => {
    const { ana, bia, view } = await restricted();
    expect(view.audience?.userIds).toEqual([]);
    expect(view.audience?.roleIds).toHaveLength(1);
    expect((await getWikiPage(f.db, person(ana.id), f.org.id, "margens")).title).toBe("Margens");
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "margens")).title).toBe("Margens");
    const agent: WikiActor = { type: "agent", agentId: f.agent.id, requestedByUserId: bia.id };
    expect((await getWikiPage(f.db, agent, f.org.id, "margens")).body).toContain("40%");
    const refused = await getWikiPage(f.db, person(bia.id), f.org.id, "margens").catch((e) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(code(refused)).toBe("wiki.no_access");
  });

  test("lists, suggestions, the graph, search, backlinks and links leave it out for others", async () => {
    const { deps, ana, bia } = await restricted();
    const titles = async (userId: string) =>
      (await listWikiPages(f.db, person(userId), f.org.id)).map((p) => p.title).sort();
    expect(await titles(ana.id)).toEqual(["Margens", "Processos"]);
    expect(await titles(bia.id)).toEqual(["Processos"]);
    expect((await suggestWikiPages(f.db, person(bia.id), f.org.id, "Marg")).length).toBe(0);
    const graph = await wikiGraph(f.db, person(bia.id), f.org.id);
    expect(graph.nodes.map((n) => n.title)).toEqual(["Processos"]);
    expect(graph.unresolved).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect((await searchWiki(deps, person(bia.id), f.org.id, "margem contratos")).length).toBe(0);
    expect((await searchWiki(deps, person(ana.id), f.org.id, "margem contratos")).length).toBe(1);
    const hits = await searchForUser(f.context, bia.id, f.org.id, { text: "margem contratos" });
    expect(hits.some((h) => h.kind === "wiki")).toBe(false);
    expect(
      (await searchForUser(f.context, ana.id, f.org.id, { text: "margem contratos" })).some((h) => h.kind === "wiki"),
    ).toBe(true);
    const page = await getWikiPage(f.db, person(bia.id), f.org.id, "processos");
    expect(page.backlinks).toEqual([]);
    expect(page.links).toEqual([{ target: "Margens", slug: "margens", title: null, exists: false }]);
    const asAdmin = await getWikiPage(f.db, person(ana.id), f.org.id, "processos");
    expect(asAdmin.backlinks.map((b) => b.kind === "page" && b.title)).toEqual(["Margens"]);
  });

  test("agents' reads, context and message links don't show its title", async () => {
    const { bia, secret, ana } = await restricted();
    await recordWikiReads(f.db, { orgId: f.org.id, agentId: f.agent.id, pageIds: [secret.id] });
    expect(await topWikiReads(f.db, person(bia.id), f.org.id)).toEqual([]);
    expect((await topWikiReads(f.db, person(ana.id), f.org.id)).map((r) => r.title)).toEqual(["Margens"]);
    const run = await retrieveWikiForRun(wikiDeps(), {
      orgId: f.org.id,
      agentId: f.agent.id,
      text: "qual a margem mínima dos contratos?",
    });
    expect(run.pageIds).toContain(secret.id);
    const [linked] = await withWikiLinks(f.db, f.org.id, [{ body: "veja [[Margens]]", meta: {} as Record<string, unknown> }]);
    expect(linked?.meta.wikiLinks).toEqual([
      {
        target: "Margens",
        label: "Margens",
        section: null,
        slug: "margens",
        title: null,
        exists: true,
        restricted: true,
      },
    ]);
    expect(await resolveWikiTargets(f.db, f.org.id, parseWikiLinks("[[Processos]]"))).toEqual([
      { target: "Processos", label: "Processos", section: null, slug: "processos", title: "Processos", exists: true },
    ]);
  });

  test("nobody outside writes it, not even an agent on their behalf", async () => {
    const { deps, bia, secret } = await restricted();
    const edit = (actor: WikiActor) =>
      updateWikiPage(deps, actor, f.org.id, "margens", { baseVersion: secret.version, body: "nada" }).catch((e) => e);
    expect(code(await edit(person(bia.id)))).toBe("wiki.no_access");
    expect(code(await edit({ type: "agent", agentId: f.agent.id, requestedByUserId: bia.id }))).toBe("wiki.no_access");
    const ok = await edit({ type: "agent", agentId: f.agent.id, requestedByUserId: f.owner.id });
    expect(ok.body).toBe("nada");
  });

  test("a new page named like one the writer can't see takes the next address instead of naming it", async () => {
    const { deps, bia } = await restricted();
    const mine = await createWikiPage(deps, person(bia.id), f.org.id, { title: "Margens", body: "outra" });
    expect(mine.slug).toBe("margens-2");
  });

  test("who may choose the audience, and only one they stay in", async () => {
    const { deps, ana, bia } = await restricted();
    const forbidden = await setWikiPageAudience(deps, bia.id, f.org.id, "processos", {
      roleIds: [],
      userIds: [],
    }).catch((e) => e);
    expect(code(forbidden)).toBe("wiki.audience_forbidden");
    const outside = await setWikiPageAudience(deps, ana.id, f.org.id, "processos", {
      roleIds: [],
      userIds: [bia.id],
    }).catch((e) => e);
    expect(outside).toBeInstanceOf(ValidationError);
    expect(code(outside)).toBe("wiki.audience_excludes_you");
    // Agents only (and owners): an owner may leave both lists empty.
    const agentsOnly = await setWikiPageAudience(deps, f.owner.id, f.org.id, "processos", { roleIds: [], userIds: [] });
    expect(agentsOnly.audience).toEqual({ roleIds: [], userIds: [] });
    expect(code(await getWikiPage(f.db, person(ana.id), f.org.id, "processos").catch((e) => e))).toBe("wiki.no_access");
    // A person named on the page sees it; opening it again shows it to everyone.
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "processos", { roleIds: [], userIds: [bia.id, "nobody"] });
    expect((await getWikiPage(f.db, person(bia.id), f.org.id, "processos")).audience).toEqual({
      roleIds: [],
      userIds: [bia.id],
    });
    expect((await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", null)).audience).toBeNull();
    expect((await getWikiPage(f.db, person(bia.id), f.org.id, "margens")).title).toBe("Margens");
  });
});
