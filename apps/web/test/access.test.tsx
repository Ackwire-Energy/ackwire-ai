import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { AccessInput } from "@/api/types";
import { groupState } from "@/components/AccessMatrix";
import {
  countTools,
  cycleTool,
  modelFrom,
  presetModel,
  resolve,
  setDenied,
  toggle,
  toInput,
  treeFromAccess,
} from "@/lib/access";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { fakeAccessTree } from "./fakes/access";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const conns = [
  {
    id: "conn-gh",
    connector: "github",
    label: "GitHub",
    accountLabel: "acme",
    authType: "oauth",
    serverUrl: null,
    createdAt: "",
    revokedAt: null,
  },
] as never;
const input = (over: Partial<AccessInput> = {}): AccessInput => ({
  all: false,
  connectors: {},
  scopes: [],
  tools: { allow: [], deny: [] },
  ...over,
});

describe("access model (same order as the gateway: deny > tool > connector > scope > all)", () => {
  test("round-trips the server tree: grants, connector, denials", () => {
    const access = fakeAccessTree(
      input({
        connectors: { "conn-gh": true },
        scopes: [{ connectionId: null, scope: "drive:write" }],
        tools: { allow: [], deny: [{ connectionId: "conn-gh", name: "github_merge_pull_request" }] },
      }),
      conns,
    );
    const tree = treeFromAccess(access);
    const model = modelFrom(access);
    expect(model.grants.has("connector:conn-gh")).toBe(true);
    expect(model.grants.has("area:drive")).toBe(true);
    expect(model.denies.has("tool:conn-gh|github_merge_pull_request")).toBe(true);
    const back = toInput(model, tree);
    expect(back.connectors).toEqual({ "conn-gh": true });
    expect(back.scopes).toEqual([{ connectionId: null, scope: "drive:write" }]);
    expect(back.tools.deny).toEqual([{ connectionId: "conn-gh", name: "github_merge_pull_request" }]);
    // "Perguntar à pessoa" is always on and never sent as a grant.
    const resolved = resolve(tree, model);
    expect(resolved.find((g) => g.id === "area:chat")?.checked).toBe(true);
    expect(back.scopes.some((s) => s.scope === "")).toBe(false);
  });

  test("tri-state groups, inherited children, deny under 'all tools', counts", () => {
    const access = fakeAccessTree(input(), conns);
    const tree = treeFromAccess(access);
    let model = modelFrom(access);
    const gh = tree.find((g) => g.id === "connector:conn-gh");
    const pr = gh?.children.find((t) => t.ref.kind === "tool" && t.ref.name === "github_create_pull_request");
    if (!gh || !pr) throw new Error("tree");
    model = toggle(model, pr, true, false);
    expect(resolve(tree, model).find((g) => g.id === gh.id)?.checked).toBe("indeterminate");
    model = { ...model, allTools: true };
    model = setDenied(model, "tool:conn-gh|github_merge_pull_request", true);
    const r = resolve(tree, model);
    expect(r.find((g) => g.id === "area:issues")?.children[0]?.state).toBe("inherited");
    expect(countTools(r)).toEqual({ on: 14, total: 15 });
    // Unchecking an inherited tool is a denial; checking it again lifts it.
    const issues = tree.find((g) => g.id === "area:issues");
    const first = issues?.children[0];
    if (!issues || !first) throw new Error("tree");
    model = toggle(model, first, false, true);
    expect(model.denies.has(first.id)).toBe(true);
    model = toggle(model, first, true, true);
    expect(model.denies.has(first.id)).toBe(false);
    // A denied group becomes denials of its tools.
    model = toggle(model, gh, false, true);
    expect(
      toInput(model, tree)
        .tools.deny.map((t) => t.name)
        .sort(),
    ).toEqual(["github_create_pull_request", "github_list_pull_requests", "github_merge_pull_request"]);
  });

  test("presets: read only, standard (no approval), all", () => {
    const tree = treeFromAccess(fakeAccessTree(input(), conns));
    const ro = presetModel(tree, "readonly");
    expect([...ro.grants].sort()).toContain("tool:conn-gh|github_list_pull_requests");
    expect(ro.grants.has("tool:conn-gh|github_create_pull_request")).toBe(false);
    const std = presetModel(tree, "standard");
    expect(std.grants.has("tool:conn-gh|github_merge_pull_request")).toBe(false);
    expect(std.grants.has("tool:conn-gh|github_create_pull_request")).toBe(true);
    expect(presetModel(tree, "all").allTools).toBe(true);
  });

  test("matrix cell cycle and group summary", () => {
    const access = fakeAccessTree(input(), conns);
    const tree = treeFromAccess(access);
    let model = modelFrom(access);
    model = cycleTool(model, tree, "conn-gh|github_merge_pull_request");
    expect(model.grants.has("tool:conn-gh|github_merge_pull_request")).toBe(true);
    model = cycleTool(model, tree, "conn-gh|github_merge_pull_request");
    expect(model.denies.has("tool:conn-gh|github_merge_pull_request")).toBe(true);
    model = cycleTool(model, tree, "conn-gh|github_merge_pull_request");
    expect(model.denies.has("tool:conn-gh|github_merge_pull_request")).toBe(false);
    expect(groupState(["granted", "inherited"])).toBe("granted");
    expect(groupState(["inherited", "inherited"])).toBe("inherited");
    expect(groupState(["off", "denied"])).toBe("denied");
    expect(groupState(["off", "granted"])).toBe("partial");
  });
});

describe("Configurações → Agentes e acesso", () => {
  const goAccess = async (state = seedState()) => {
    await renderApp(`/org/${ORG_ID}/settings/access`, { api: createFakeApi(state) });
    await settle(8);
    return within(screen().getByRole("region", { name: "Acesso dos agentes" }));
  };

  test("one row per agent with a summary; Editar opens that agent's permissions", async () => {
    const section = await goAccess();
    const rows = Array.from(document.querySelectorAll(".access-agent")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Ada");
    expect(rows[0]).toContain("5 de 15 ferramentas · Contexto e memória, Skills");
    await click(section.getByRole("button", { name: "Editar permissões de Ada" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Permissões da Ada" })).toBeTruthy();
  });

  test("matrix dialog: staged changes, one PUT per changed agent on Salvar; Descartar reverts", async () => {
    const state = seedState();
    const section = await goAccess(state);
    await click(section.getByRole("button", { name: "Ver todas as permissões" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Todas as permissões" });
    const headers = within(dialog)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Ferramenta", "Ada", "Atlas"]);
    // Groups show how many tools they hold.
    expect(within(dialog).getByRole("button", { name: "Mostrar ferramentas de Issues" }).textContent).toContain(
      "Issues · 2",
    );
    await click(within(dialog).getByRole("button", { name: "Mostrar ferramentas de GitHub" }));
    await click(within(dialog).getByRole("button", { name: "Ada · Fazer merge: sem acesso" }));
    await click(within(dialog).getByRole("button", { name: "Atlas · Abrir PR: sem acesso" }));
    // Nothing saved yet: the footer counts the staged changes.
    expect(state.calls.some((c) => c.method === "access.set")).toBe(false);
    expect(dialog.textContent).toContain("2 alterações");
    expect(within(dialog).getByRole("button", { name: "Ada · Fazer merge: liberada" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Descartar" }));
    expect(within(dialog).getByRole("button", { name: "Ada · Fazer merge: sem acesso" })).toBeTruthy();
    expect(dialog.textContent).not.toContain("alterações");
    await click(within(dialog).getByRole("button", { name: "Ada · Fazer merge: sem acesso" }));
    await click(within(dialog).getByRole("button", { name: "Atlas · Abrir PR: sem acesso" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1]).sort()).toEqual([ADA_ID, ATLAS_ID].sort());
    expect((puts.find((c) => c.args[1] === ADA_ID)?.args[2] as AccessInput | undefined)?.tools.allow).toContainEqual({
      connectionId: "conn-gh",
      name: "github_merge_pull_request",
    });
  });

  test("inherited cells: a muted check with a tooltip saying where it comes from; closing with changes asks", async () => {
    const section = await goAccess();
    await click(section.getByRole("button", { name: "Ver todas as permissões" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Todas as permissões" });
    const context = within(dialog).getByRole("button", { name: "Mostrar ferramentas de Contexto e memória" });
    expect(context.textContent).toContain("Contexto e memória · 3");
    await click(context);
    const memoryCell = within(dialog).getByRole("button", { name: "Ada · Lembrar: liberada" });
    expect(memoryCell.closest("td")?.getAttribute("data-state")).toBe("granted");
    await click(within(dialog).getByRole("button", { name: "Mostrar ferramentas de Conversa" }));
    const ask = within(dialog).getByRole("button", { name: "Ada · Perguntar: Liberada por Conversa" });
    expect(ask.getAttribute("title")).toBe("Liberada por Conversa");
    expect(ask.closest("td")?.getAttribute("data-state")).toBe("inherited");
    await click(within(dialog).getByRole("button", { name: "Ada · Ler issues: sem acesso" }));
    await click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(dialog.textContent).toContain("Descartar as alterações?");
  });

  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await renderApp(`/org/${ORG_ID}/settings/access`, { api: createFakeApi(state) });
    await settle(6);
    expect(screen().queryByRole("region", { name: "Acesso dos agentes" })).toBeNull();
  });
});

describe("Criar agente → Ferramentas", () => {
  test("presets open the same tree; the choice is saved with the new agent", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(state) });
    await settle(8);
    const tools = screen().getByRole("region", { name: "Ferramentas" });
    expect(
      within(tools)
        .getByRole("button", { name: /Padrão/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(tools).getByRole("checkbox", { name: "Fazer merge" }).getAttribute("aria-checked")).toBe("false");
    await click(within(tools).getByRole("button", { name: /Só leitura/ }));
    expect(within(tools).getByRole("checkbox", { name: "Abrir PR" }).getAttribute("aria-checked")).toBe("false");
    await click(within(tools).getByRole("button", { name: /Todas/ }));
    expect(
      within(tools)
        .getByRole("switch", { name: "Todas as ferramentas (atuais e futuras)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await type(screen().getByLabelText("Nome"), "Iris");
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const put = state.calls.filter((c) => c.method === "access.set").at(-1)?.args[2] as AccessInput;
    expect(put.all).toBe(true);
  });
});
