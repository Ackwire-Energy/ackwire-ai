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
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
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
    expect(model.grants.has("scope:|drive:write")).toBe(true);
    expect(model.denies.has("tool:conn-gh|github_merge_pull_request")).toBe(true);
    const back = toInput(model, tree);
    expect(back.connectors).toEqual({ "conn-gh": true });
    expect(back.scopes).toEqual([{ connectionId: null, scope: "drive:write" }]);
    expect(back.tools.deny).toEqual([{ connectionId: "conn-gh", name: "github_merge_pull_request" }]);
    // "Perguntar à pessoa" is always on and never sent as a grant.
    const resolved = resolve(tree, model);
    expect(resolved.find((g) => g.label === "Perguntar à pessoa")?.checked).toBe(true);
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
    expect(r.find((g) => g.id === "scope:|issues:write")?.children[0]?.state).toBe("inherited");
    expect(countTools(r)).toEqual({ on: 14, total: 15 });
    // Unchecking an inherited tool is a denial; checking it again lifts it.
    const issues = tree.find((g) => g.id === "scope:|issues:write");
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

describe("Configurações → Acesso dos agentes", () => {
  test("agents as columns, groups as rows (expand into tools), click a tool cell to change it", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings`, { api: createFakeApi(state) });
    await settle(8);
    const section = screen().getByRole("region", { name: "Acesso dos agentes" });
    const headers = within(section)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Ferramenta", "Ada", "Atlas"]);
    expect(section.querySelector("th.access-matrix__sticky")).not.toBeNull();
    await click(within(section).getByRole("button", { name: "Mostrar ferramentas de GitHub" }));
    const cell = within(section).getByRole("button", { name: "Ada · Fazer merge: sem acesso" });
    await click(cell);
    await settle(6);
    const put = state.calls.filter((c) => c.method === "access.set").at(-1)?.args;
    expect(put?.[1]).toBe(ADA_ID);
    expect((put?.[2] as AccessInput | undefined)?.tools.allow).toEqual([
      { connectionId: "conn-gh", name: "github_merge_pull_request" },
    ]);
    expect(within(section).getByRole("button", { name: "Ada · Fazer merge: liberada" })).toBeTruthy();
    // Search finds a tool inside a collapsed group.
    await type(within(section).getByRole("searchbox", { name: "Buscar ferramenta ou grupo" }), "criar issue");
    expect(within(section).getByText("Criar issue")).toBeTruthy();
  });

  test("members don't see the matrix", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await renderApp(`/org/${ORG_ID}/settings`, { api: createFakeApi(state) });
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
