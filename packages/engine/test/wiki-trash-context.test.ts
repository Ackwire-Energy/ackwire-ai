import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createWikiPage,
  deleteWikiPage,
  deleteWikiPages,
  drainOutbox,
  getWikiFolderAudience,
  getWikiPage,
  importWikiPages,
  listWikiPages,
  purgeDeletedWikiPages,
  purgeWikiPages,
  recordWikiReads,
  restoreWikiPages,
  retrieveWikiForRun,
  setWikiFolderAudience,
  setWikiPageAgentContext,
  setWikiPageLock,
  setWikiPagesAgents,
  topWikiReads,
  type WikiActor,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const deps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context });
const code = (e: unknown) => (e as { code?: string }).code;
const IMPORT = "0190a000-0000-7000-8000-000000000001";

async function page(title: string, folder = "", body = "") {
  return createWikiPage(deps(), person(f.owner.id), f.org.id, { title, folder, body });
}

const live = async () => (await listWikiPages(f.db, person(f.owner.id), f.org.id)).map((p) => p.title).sort();
const trash = async () =>
  (await listWikiPages(f.db, person(f.owner.id), f.org.id, { deleted: true })).map((p) => p.title).sort();

describe("deleting many pages", () => {
  test("a selection, a folder with its subfolders, an import by id and an older import by its vault", async () => {
    f = await setup();
    const a = await page("A");
    await page("B");
    await page("Contrato", "Financeiro");
    await page("Acme", "Financeiro/Clientes");
    await page("Outra", "Financeirox");
    await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: { type: "obsidian", name: "Vault" },
      onConflict: "keep_both",
      importId: IMPORT,
      notes: [{ title: "Nota 1", body: "x" }],
    });
    await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: { type: "obsidian", name: "Vault" },
      onConflict: "keep_both",
      notes: [{ title: "Nota antiga", body: "x" }],
    });

    expect(await deleteWikiPages(deps(), f.owner.id, f.org.id, { ids: [a.id] })).toEqual({ deleted: 1, kept: 0 });
    expect(await deleteWikiPages(deps(), f.owner.id, f.org.id, { folder: "Financeiro" })).toEqual({
      deleted: 2,
      kept: 0,
    });
    expect(await deleteWikiPages(deps(), f.owner.id, f.org.id, { importId: IMPORT })).toEqual({
      deleted: 1,
      kept: 0,
    });
    expect(
      await deleteWikiPages(deps(), f.owner.id, f.org.id, { source: { type: "obsidian", name: "Vault" } }),
    ).toEqual({ deleted: 1, kept: 0 });
    expect(await live()).toEqual(["B", "Outra"]);
    expect(await trash()).toEqual(["A", "Acme", "Contrato", "Nota 1", "Nota antiga"]);
    const imported = (await listWikiPages(f.db, person(f.owner.id), f.org.id, { deleted: true })).find(
      (p) => p.title === "Nota 1",
    );
    expect(imported).toMatchObject({ importId: IMPORT, sourceName: "Vault", sourceType: "obsidian" });
    expect(imported?.deletedAt).toBeString();
  });

  test("a locked page stays for a member who can't edit it, and counts as kept", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await page("Aberta", "Docs");
    await page("Trancada", "Docs");
    await setWikiPageLock(deps(), f.owner.id, f.org.id, "trancada", true);
    expect(await deleteWikiPages(deps(), bia.id, f.org.id, { folder: "Docs" })).toEqual({ deleted: 1, kept: 1 });
    expect(await live()).toEqual(["Trancada"]);
  });
});

describe("the trash", () => {
  test("restores many at once, and one whose address was taken stays with the reason", async () => {
    f = await setup();
    const a = await page("Deploy");
    const b = await page("Glossário");
    await deleteWikiPages(deps(), f.owner.id, f.org.id, { ids: [a.id, b.id] });
    await page("Deploy");
    const result = await restoreWikiPages(deps(), f.owner.id, f.org.id, [a.id, b.id]);
    expect(result.restored).toBe(1);
    expect(result.failed).toEqual([{ id: a.id, title: "Deploy", code: "wiki.restore_slug_taken" }]);
    expect(await live()).toEqual(["Deploy", "Glossário"]);
    expect(await trash()).toEqual(["Deploy"]);
  });

  test("delete for good, empty it, and the purge after 30 days", async () => {
    f = await setup();
    const a = await page("A");
    const b = await page("B");
    const c = await page("C");
    for (const p of [a, b, c]) await deleteWikiPage(deps(), person(f.owner.id), f.org.id, p.id);
    expect(await purgeWikiPages(deps(), f.owner.id, f.org.id, [a.id])).toEqual({ purged: 1, kept: 0 });
    expect(await trash()).toEqual(["B", "C"]);

    // Past the window: out of the trash at once, and gone at the next purge.
    await f.db
      .update(schema.wikiPages)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(schema.wikiPages.id, b.id));
    expect(await trash()).toEqual(["C"]);
    expect(await purgeDeletedWikiPages(f.db)).toBe(1);
    expect(await purgeWikiPages(deps(), f.owner.id, f.org.id)).toEqual({ purged: 1, kept: 0 });
    expect(await f.db.select().from(schema.wikiPages)).toEqual([]);
  });
});

describe("the agents' access for many pages, and for the root", () => {
  test("a selection keeps who sees each page and changes only the agents", async () => {
    f = await setup();
    const a = await page("A");
    const b = await page("B");
    const done = await setWikiPagesAgents(deps(), f.owner.id, f.org.id, [a.id, b.id], []);
    expect(done).toEqual({ changed: 2, failed: [] });
    const view = await getWikiPage(f.db, person(f.owner.id), f.org.id, "a");
    expect(view.agentIds).toEqual([]);
    expect(view.audience).toBeNull();
  });

  test("the root's audience reaches every page, and a folder below can only be narrower", async () => {
    f = await setup();
    await page("Na raiz");
    await page("Contrato", "Financeiro");
    const done = await setWikiFolderAudience(deps(), f.owner.id, f.org.id, "", null, [f.agent.id]);
    expect(done.pages).toBe(2);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "na-raiz")).agentIds).toEqual([f.agent.id]);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "contrato")).audienceFolder).toBe("");
    const info = await getWikiFolderAudience(f.db, f.owner.id, f.org.id, "Financeiro");
    expect(info.above?.folder).toBe("");
    expect((await getWikiFolderAudience(f.db, f.owner.id, f.org.id, "")).above).toBeNull();
    // A new page anywhere takes it.
    expect((await page("Nova")).agentIds).toEqual([f.agent.id]);
    // Opening the root opens them again.
    await setWikiFolderAudience(deps(), f.owner.id, f.org.id, "", null, null);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "contrato")).agentIds).toBeNull();
  });
});

describe("always in the agents' context", () => {
  test("at most 3 pages, and they go in for a message about anything else", async () => {
    f = await setup();
    const pages = [];
    for (const t of ["Regras", "Tom de voz", "Clientes", "Quarta"]) pages.push(await page(t, "", `Texto de ${t}.`));
    for (const p of pages.slice(0, 3)) await setWikiPageAgentContext(deps(), f.owner.id, f.org.id, p.id, true);
    const full = await setWikiPageAgentContext(deps(), f.owner.id, f.org.id, "quarta", true).catch((e) => e);
    expect(code(full)).toBe("wiki.context_full");
    await drainOutbox(f.db, f.handlers);
    const run = await retrieveWikiForRun(deps(), {
      orgId: f.org.id,
      text: "oi",
      reader: async () => ({ type: "agent", agentId: f.agent.id, requestedByUserId: f.owner.id }),
    });
    expect(run.pageIds.sort()).toEqual(
      pages
        .slice(0, 3)
        .map((p) => p.id)
        .sort(),
    );
    expect(run.text).toContain("Texto de Regras.");
    // Off again: room for another.
    await setWikiPageAgentContext(deps(), f.owner.id, f.org.id, "regras", false);
    expect((await setWikiPageAgentContext(deps(), f.owner.id, f.org.id, "quarta", true)).agentContext).toBe(true);
  });
});

describe("what goes into a run's context", () => {
  const filler = [
    "O time de vendas usa o CRM para registrar cada lead e cada proposta enviada ao cliente.",
    "As reuniões semanais acontecem às segundas, com pauta enviada na sexta.",
    "Férias são marcadas com trinta dias de antecedência no sistema de RH.",
    "O atendimento ao cliente responde chamados em até um dia útil.",
    "Senhas ficam no cofre compartilhado, nunca em planilhas.",
    "Os relatórios mensais de métricas vão para a diretoria no dia cinco.",
    "Contratos com fornecedores passam pelo jurídico antes da assinatura.",
    "A marca segue o guia visual com as cores e fontes oficiais.",
    "Um cliente que pediu reembolso uma vez foi atendido pelo financeiro.",
  ];
  async function wiki() {
    f = await setup();
    let long = "";
    for (let i = 0; i < 300; i++) long += `${filler[(i * 7) % filler.length]} `;
    const manual = await page("Manual da empresa", "", long);
    const refund = await page(
      "Política de reembolso",
      "Financeiro",
      "Clientes podem pedir reembolso em até 7 dias após a compra. O pedido vai para o financeiro e o gerente aprova. Assinatura anual tem reembolso proporcional.",
    );
    const deploy = await page(
      "Guia de deploy",
      "Engenharia",
      "O deploy do backend roda pelo script deploy.sh. Antes rode os testes e confira o changelog. Para voltar, use o rollback.",
    );
    await drainOutbox(f.db, f.handlers);
    const ask = (text: string) =>
      retrieveWikiForRun(deps(), {
        orgId: f.org.id,
        text,
        reader: async () => ({ type: "agent", agentId: f.agent.id, requestedByUserId: f.owner.id }),
      });
    return { manual, refund, deploy, ask };
  }

  test("an unrelated message gets no wiki", async () => {
    const { ask } = await wiki();
    for (const text of [
      "qual é a previsão do tempo para amanhã em Lisboa?",
      "bom dia, tudo bem com vocês hoje?",
      "pode revisar o texto do post de lançamento?",
      "what do you think about the new logo?",
    ]) {
      expect({ text, ids: (await ask(text)).pageIds }).toEqual({ text, ids: [] });
    }
  });

  test("a related message gets the right page first, and the long page doesn't beat the short exact one", async () => {
    const { refund, deploy, ask } = await wiki();
    expect((await ask("como funciona o reembolso de uma assinatura anual?")).pageIds[0]).toBe(refund.id);
    expect((await ask("o cliente pediu reembolso, o que faço?")).pageIds[0]).toBe(refund.id);
    expect((await ask("como faço o deploy do backend?")).pageIds).toEqual([deploy.id]);
  });

  test("a page the message names goes in even when the search wouldn't pick it", async () => {
    const { manual, ask } = await wiki();
    expect((await ask("resuma o [[Manual da empresa]] para mim")).pageIds[0]).toBe(manual.id);
  });
});

describe("what the agents read most", () => {
  test("counts pages agents opened, not pages that only went into their context", async () => {
    f = await setup();
    const a = await page("Aberta");
    const b = await page("Só no contexto");
    await recordWikiReads(f.db, { orgId: f.org.id, agentId: f.agent.id, pageIds: [a.id], kind: "opened" });
    for (let i = 0; i < 5; i++)
      await recordWikiReads(f.db, { orgId: f.org.id, agentId: f.agent.id, pageIds: [b.id], kind: "context" });
    expect((await topWikiReads(f.db, person(f.owner.id), f.org.id)).map((r) => r.title)).toEqual(["Aberta"]);
    // The page itself still says which agents used it.
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, b.id)).reads.total).toBe(5);
  });
});

describe("importing in batches", () => {
  test("a note past a limit is cut or comes back failed, and the rest of the batch goes in", async () => {
    f = await setup();
    const result = await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: { type: "obsidian", name: "Vault" },
      onConflict: "keep_both",
      importId: IMPORT,
      notes: [
        { title: "Tags longas", body: "x", tags: ["t".repeat(120)], aliases: ["a".repeat(400)] },
        { title: "Anexo", body: "![[x]]", attachments: { ["n".repeat(400)]: "00000000-0000-4000-8000-000000000001" } },
        { title: "Enorme", body: "x".repeat(200_001) },
        { title: "Boa", body: "ok" },
      ],
    });
    expect(result.created.map((p) => p.title)).toEqual(["Tags longas", "Anexo", "Boa"]);
    expect(result.failed).toEqual([{ title: "Enorme", reason: "too_long" }]);
    expect(result.created.every((p) => p.importId === IMPORT)).toBe(true);
    // A retry with "skip" doesn't duplicate what came in.
    const again = await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: { type: "obsidian", name: "Vault" },
      onConflict: "skip",
      importId: IMPORT,
      notes: [{ title: "Boa", body: "ok" }],
    });
    expect(again).toMatchObject({ created: [], skipped: ["Boa"] });
  });
});
