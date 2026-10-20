import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Run } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  agentSearch,
  changedKeys,
  channelsAfter,
  isRoutineRun,
  lineChanges,
  revertKey,
  runMatches,
  type Saved,
} from "@/lib/agent-edit";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (query = "", state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${query}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** Radix tabs activate on mouse down. */
const openTab = async (name: RegExp) => {
  const tabs = screen().getByRole("tablist", { name: "Seções da Ada" });
  await act(async () => fireEvent.mouseDown(within(tabs).getByRole("tab", { name }), { button: 0 }));
  await settle(4);
};
const saveBar = () => screen().queryByRole("region", { name: "Alterações não salvas" });
const asMember = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
/** I (Walter) am a member and Ada's owner. */
const asOwner = () => {
  const state = asMember();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "u-walter";
  return state;
};
const updates = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2]);

describe("agent page: tabs and the URL", () => {
  test("six tabs; the chosen one goes to ?tab=; a link opens a tab; the memory tab counts the proposal", async () => {
    const { router } = await go();
    const tabs = screen().getByRole("tablist", { name: "Seções da Ada" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Visão geral", "Instruções", "Ferramentas e acesso", "Memória1", "Atividade", "Configurações"]);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    await openTab(/^Atividade/);
    expect(router.state.location.search).toMatchObject({ tab: "activity" });
    expect(screen().getByRole("searchbox", { name: "Buscar execuções" })).toBeTruthy();
    cleanup();
    await go("?tab=memory");
    expect(
      within(screen().getByRole("tablist", { name: "Seções da Ada" }))
        .getByRole("tab", { name: /^Memória/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen().getByRole("article", { name: "Atualizar as instruções da Ada" })).toBeTruthy();
  });

  test("the cover: status, numbers and the actions on the sky; the name, its @ and the sentence under it", async () => {
    await go();
    const hero = document.querySelector(".agp-hero") as HTMLElement;
    const cover = hero.querySelector(".agp-cover") as HTMLElement;
    expect(cover.textContent).toContain("Esperando aprovação");
    // The fake agent waits for an approval: the line under the status counts the requests.
    expect(cover.textContent).toContain("1 pedido");
    expect(cover.textContent).toContain("US$ 12,30");
    expect(cover.textContent).toContain("de US$ 40");
    expect(within(cover).getByRole("link", { name: "Conversar" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/agent/${ADA_ID}`,
    );
    expect(within(cover).getByRole("button", { name: "Mais ações" })).toBeTruthy();
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Ada");
    expect(hero.querySelector(".agp-handle")?.textContent).toContain("@ada");
    // No chips under the name: the sentence says what it works with.
    expect(hero.querySelector(".agp-meta")).toBeNull();
    expect(hero.querySelector(".agp-work__sentence")?.textContent).toContain("Pensa com o modelo da organização");
  });
});

describe("agent page: the budget on the overview", () => {
  test("who thinks is the sentence under the name; the overview keeps the money, Mudar opens Orçamento", async () => {
    const { router } = await go("?tab=overview");
    expect(screen().queryByRole("region", { name: "Quem pensa e orçamento" })).toBeNull();
    const card = screen().getByRole("region", { name: "Orçamento" });
    await click(within(card).getByRole("button", { name: "Mudar" }));
    expect(router.state.location.search).toMatchObject({ tab: "settings", sec: "budget" });
  });

  test("a member reads who thinks from the agent (no computer)", async () => {
    const state = asMember();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", model: "Sonnet" };
    await go("", state);
    expect(document.querySelector(".agp-work__sentence")?.textContent).toBe("Pensa com Claude Code · Sonnet.");
  });
});

describe("agent page: who edits what", () => {
  test("members read: values, not inputs; never money; no runs", async () => {
    await go("?tab=settings", asMember());
    expect(document.body.textContent).toContain("Você vê como a Ada trabalha.");
    expect(screen().queryByLabelText("Nome")).toBeNull();
    expect(screen().queryByRole("group", { name: "Cor" })).toBeNull();
    expect(screen().queryByRole("combobox", { name: "Responsável" })).toBeNull();
    expect(document.body.textContent).toContain("Só admins mudam");
    expect(document.body.textContent).toContain("Só admins veem o gasto dos agentes e mudam o limite.");
    // The model says its cost as a tier, never in dollars.
    expect(document.body.textContent).not.toContain("US$");
    await openTab(/^Visão geral/);
    expect(document.body.textContent).not.toContain("US$");
    await openTab(/^Ferramentas/);
    expect(screen().queryByRole("radiogroup", { name: "Nível em GitHub" })).toBeNull();
    await openTab(/^Atividade/);
    expect(document.body.textContent).toContain("Só admins e João veem as execuções.");
    expect(saveBar()).toBeNull();
  });

  test("the owner changes the look, access, audience and computer; the save sends only what they may", async () => {
    const { state } = await go("?tab=settings", asOwner());
    expect(screen().queryByLabelText("Nome")).toBeNull();
    expect(document.body.textContent).toContain("Você é responsável da Ada");
    // The look is right on the page: colors, then the eyes and what it wears as sliding rows.
    await click(within(screen().getByRole("group", { name: "Cor" })).getByRole("button", { name: "Rosa" }));
    expect(saveBar()?.textContent).toContain("1 alteração");
    await openTab(/^Instruções/);
    expect(screen().queryByRole("textbox", { name: "Instruções" })).toBeNull();
    expect(document.body.textContent).toContain("Só admins editam as instruções.");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(updates(state)).toEqual([{ appearance: { color: "rose", eyes: "round", accessory: "none" } }]);
  });
});

describe("agent page: inline editing and the save bar", () => {
  test("changes add up in one bar: count, names, Ver (old → new, Desfazer), Alterado on the card, Descartar", async () => {
    await go("?tab=instructions");
    const box = screen().getByRole("textbox", { name: "Instruções" });
    await type(box, "Instruções de Ada.\nAbre PRs pequenos.");
    const card = box.closest("section") as HTMLElement;
    expect(card.getAttribute("data-changed")).toBe("true");
    expect(card.textContent).toContain("Alterado");
    await click(within(card).getByRole("button", { name: "Ver o que mudou" }));
    expect(within(card).getByRole("group", { name: "O que mudou nas instruções" }).textContent).toContain(
      "Abre PRs pequenos.",
    );
    expect(
      within(screen().getByRole("tablist", { name: "Seções da Ada" })).getByRole("tab", { name: /^Instruções/ })
        .textContent,
    ).toBe("Instruções1");
    await openTab(/^Configurações/);
    await type(screen().getByLabelText("Nome"), "Ada Lovelace");
    const bar = saveBar() as HTMLElement;
    expect(bar.textContent).toContain("2 alterações");
    expect(bar.textContent).toContain("Nome e Instruções");
    await click(within(bar).getByRole("button", { name: "Ver" }));
    const list = screen().getByRole("dialog", { name: "O que mudou" });
    expect(list.textContent).toContain("1 linha nova");
    expect(list.textContent).toContain("Ada → Ada Lovelace");
    await click(within(list).getByRole("button", { name: "Desfazer: Nome" }));
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Ada");
    expect(saveBar()?.textContent).toContain("1 alteração");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: "Descartar" }));
    expect(saveBar()).toBeNull();
  });

  test("Salvar: one PATCH, one access write for every level, the channels kept, then a toast", async () => {
    const { state } = await go("?tab=access");
    const github = screen().getByRole("radiogroup", { name: "Nível em GitHub" });
    await click(within(github).getByRole("radio", { name: "Ler e escrever" }));
    const row = github.closest("li") as HTMLElement;
    expect(row.textContent).toContain("Alterado");
    expect(row.textContent).toContain("Antes: Sem acesso");
    const skills = screen().getByRole("radiogroup", { name: "Nível em Skills" });
    const other = within(skills)
      .getAllByRole("radio")
      .find((r) => r.getAttribute("aria-checked") !== "true") as HTMLElement;
    await click(other);
    await openTab(/^Configurações/);
    await type(screen().getByRole("textbox", { name: /^Orçamento mensal/ }), "55,5");
    await click(screen().getByRole("checkbox", { name: "#general" }));
    expect(saveBar()?.textContent).toContain("4 alterações");
    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(8);
    expect(updates(state)).toEqual([{ monthlyBudgetUsd: 55.5 }]);
    const writes = state.calls.filter((c) => c.method === "access.set");
    expect(writes).toHaveLength(1);
    expect((writes[0]?.args[2] as { connectors: Record<string, boolean> } | undefined)?.connectors).toEqual({
      "conn-gh": true,
    });
    expect(state.calls.find((c) => c.method === "agents.setChannels")?.args[2]).toEqual([
      { channelId: ENG_ID, autoReply: true },
      { channelId: GENERAL_ID },
    ]);
    expect(document.body.textContent).toContain("Alterações da Ada salvas.");
    expect(saveBar()).toBeNull();
  });

  test("⌘S saves; an invalid budget blocks it and says why", async () => {
    const { state } = await go("?tab=settings&sec=budget");
    const budget = screen().getByRole("textbox", { name: /^Orçamento mensal/ });
    await type(budget, "0");
    expect(saveBar()?.textContent).toContain("Use um valor maior que zero.");
    await act(async () => fireEvent.keyDown(document, { key: "s", metaKey: true }));
    await settle(4);
    expect(updates(state)).toEqual([]);
    await type(budget, "");
    await act(async () => fireEvent.keyDown(document, { key: "s", ctrlKey: true }));
    await settle(6);
    expect(updates(state)).toEqual([{ monthlyBudgetUsd: null }]);
  });

  test("leaving with unsaved changes asks first", async () => {
    const { router } = await go("?tab=instructions");
    await type(screen().getByRole("textbox", { name: "Instruções" }), "Outra coisa.");
    await act(async () => {
      router.history.push(`/org/${ORG_ID}/approvals`);
    });
    await settle(4);
    const ask = screen().getByRole("dialog", { name: "Sair sem salvar?" });
    expect(ask.textContent).toContain("Há 1 alteração não salva da Ada.");
    await click(within(ask).getByRole("button", { name: "Continuar editando" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    expect(screen().getByRole("textbox", { name: "Instruções" })).toBeTruthy();
    await act(async () => {
      router.history.push(`/org/${ORG_ID}/approvals`);
    });
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "Sair sem salvar?" })).getByRole("button", {
        name: "Descartar e sair",
      }),
    );
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/approvals`);
  });
});

describe("agent page: memory and proposals", () => {
  test("Aceitar mudança uses the proposals API", async () => {
    const { state } = await go("?tab=memory");
    const card = screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    expect(card.textContent).toContain("Aguardando você");
    await click(within(card).getByRole("button", { name: "Aceitar mudança" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([ORG_ID, "prop-1", undefined]);
    expect(document.body.textContent).toContain("Mudança aceita. As instruções foram atualizadas.");
  });

  test("Editar antes de aceitar sends the final text; Recusar refuses", async () => {
    const { state } = await go("?tab=memory");
    const card = screen().getByRole("article", { name: "Atualizar as instruções da Ada" });
    await click(within(card).getByRole("button", { name: "Editar antes de aceitar" }));
    await type(within(card).getByLabelText("Texto final das instruções"), "Só PRs pequenos.");
    await click(within(card).getByRole("button", { name: "Aceitar com ajustes" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([
      ORG_ID,
      "prop-1",
      "Só PRs pequenos.",
    ]);
    cleanup();
    const second = await go("?tab=memory");
    await click(
      within(screen().getByRole("article", { name: "Atualizar as instruções da Ada" })).getByRole("button", {
        name: "Recusar",
      }),
    );
    await settle(4);
    expect(second.state.calls.find((c) => c.method === "proposals.refuse")?.args).toEqual([ORG_ID, "prop-1"]);
  });

  test("what it knows: kinds and search", async () => {
    await go("?tab=memory");
    const kinds = screen().getByRole("radiogroup", { name: "Tipo" });
    expect(
      within(kinds)
        .getAllByRole("radio")
        // The count is a separate chip (CountChip): no text space between label and number.
        .map((r) => r.textContent?.replace(/(\D)(\d+)$/, "$1 $2")),
    ).toEqual(["Fatos e decisões 4", "Lições 2", "Arquivados 1"]);
    await type(screen().getByRole("searchbox", { name: "Buscar" }), "zzz-nada");
    expect(document.body.textContent).toContain("Nada encontrado com “zzz-nada”.");
  });
});

describe("agent page: activity", () => {
  const extra = (over: Partial<Run>): Run => ({
    id: "run-x",
    agentId: ADA_ID,
    channelId: ENG_ID,
    threadId: "m-1",
    trigger: "mention",
    status: "done",
    error: null,
    what: "",
    turns: 1,
    inputTokens: 100,
    outputTokens: 10,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...over,
  });

  test("by day, with tokens; filters for failures and waiting; search", async () => {
    const state = seedState();
    state.runs.push(
      extra({ id: "run-f", what: "roda a suíte de checkout", status: "failed", errorCode: "run.budget_exceeded" }),
      extra({ id: "run-w", what: "faz o merge do PR #42", status: "waiting_approval" }),
    );
    await go("?tab=activity", state);
    const runs = screen().getByRole("region", { name: "Execuções" });
    expect(runs.textContent).toContain("@ada o login está devolvendo 401");
    expect(runs.textContent).toContain("1.240 tokens");
    expect(within(runs).getByRole("region", { name: "Hoje" })).toBeTruthy();
    const filters = within(runs).getByRole("radiogroup", { name: "Filtrar execuções" });
    await click(within(filters).getByRole("radio", { name: /^Falhas/ }));
    expect(runs.textContent).toContain("roda a suíte de checkout");
    expect(runs.textContent).toContain("O orçamento do mês acabou.");
    expect(runs.textContent).not.toContain("faz o merge");
    await click(within(filters).getByRole("radio", { name: /^Esperando/ }));
    expect(runs.textContent).toContain("faz o merge do PR #42");
    expect(runs.textContent).not.toContain("roda a suíte");
    await click(within(filters).getByRole("radio", { name: "Todas" }));
    await type(within(runs).getByRole("searchbox", { name: "Buscar execuções" }), "PR #39");
    expect(runs.textContent).toContain("Mostrando 1 de 1.");
    // Admins see what the month cost.
    expect(document.body.textContent).toContain("US$ 12,30");
  });
});

describe("agent page rules", () => {
  const saved: Saved = {
    name: "Ada",
    role: "Dev",
    look: { color: "sky", eyes: "round", accessory: "none" },
    instructions: "a\nb",
    model: "m",
    owner: "u1",
    audience: { mode: "everyone", userIds: [] },
    levels: { "connector:gh": "none", "area:skills": "read" },
    budget: null,
    channels: ["c1"],
  };

  test("only real differences count; undo removes one", () => {
    expect(changedKeys(saved, { name: "Ada", budget: "" })).toEqual([]);
    const edits = { name: "Ada L", levels: { "connector:gh": "write" as const, "area:skills": "read" as const } };
    expect(changedKeys(saved, edits).map((c) => c.key)).toEqual(["name", "levels:connector:gh"]);
    expect(changedKeys(saved, revertKey(edits, "levels:connector:gh")).map((c) => c.key)).toEqual(["name"]);
    expect(changedKeys(saved, { budget: "40" }).map((c) => c.key)).toEqual(["budget"]);
    expect(changedKeys(saved, { audience: { mode: "people", userIds: [] } }).map((c) => c.key)).toEqual(["audience"]);
  });

  test("channels: the PUT keeps DMs, private channels and auto-reply", () => {
    const current = [
      { id: "c1", autoReply: false },
      { id: "dm", autoReply: true },
    ];
    expect(channelsAfter(current, ["c1"], ["c2"])).toEqual([{ channelId: "dm", autoReply: true }, { channelId: "c2" }]);
    expect(channelsAfter(current, ["c1"], ["c1", "c2"])).toEqual([
      { channelId: "c1", autoReply: false },
      { channelId: "dm", autoReply: true },
      { channelId: "c2" },
    ]);
  });

  test("routine runs, filters, line counts and the URL", () => {
    const r = { what: "@ada Resuma a semana do #eng" };
    expect(isRoutineRun(r, ["Resuma a semana do #eng"], "ada")).toBe(true);
    expect(isRoutineRun(r, [""], "ada")).toBe(false);
    const run = { status: "failed", what: "x" } as Run;
    expect(runMatches(run, "failed", "", { where: "#eng", routine: false })).toBe(true);
    expect(runMatches(run, "routines", "", { where: "#eng", routine: false })).toBe(false);
    expect(runMatches(run, "all", "eng", { where: "#eng", routine: false })).toBe(true);
    expect(lineChanges("a\nb", "a\nc\nb")).toEqual({ added: 1, removed: 0 });
    expect(agentSearch({ tab: "memory", sec: "nope" })).toEqual({ tab: "memory", sec: undefined });
    // The old "Modelo e chave" anchor lands on "Quem pensa".
    expect(agentSearch({ tab: "settings", sec: "model" })).toEqual({ tab: "settings", sec: "brain" });
  });
});
