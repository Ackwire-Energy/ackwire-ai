import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(1);
};
const open = async (prepare?: (api: ReturnType<typeof createFakeApi>) => Promise<unknown>) => {
  const state = seedState();
  const api = createFakeApi(state);
  await prepare?.(api);
  await renderApp(`/org/${ORG_ID}/routines`, { api });
  await settle(8);
  return { state, api };
};
const card = (name: string) => screen().getByRole("article", { name });
const menu = async (name: string, item: string) => {
  const trigger = within(card(name)).getByRole("button", { name: `Mais ações: ${name}` });
  trigger.focus();
  await key(trigger, "Enter");
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: item }));
  await settle(4);
};

describe("Rotinas: editar, duplicar, apagar", () => {
  test("Editar opens the form filled in; Salvar sends only what changed and shows the next run", async () => {
    const { state } = await open();
    await menu("Resumo da semana", "Editar");
    const dialog = screen().getByRole("dialog", { name: "Editar rotina" });
    expect((within(dialog).getByLabelText("O que fazer") as HTMLTextAreaElement).value).toContain("Resuma o que");
    expect((within(dialog).getByLabelText("Título") as HTMLInputElement).value).toBe("Resumo da semana");
    expect((within(dialog).getByLabelText("Frequência") as HTMLInputElement).value).toBe("toda segunda às 9h");
    expect(dialog.textContent).toContain("Toda semana, seg, às 09:00");
    await type(within(dialog).getByLabelText("Frequência"), "dias úteis às 8h30");
    await settle(4);
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "routines.update");
    const patch = call?.args[1] as { trigger?: { type: string; rule?: unknown } };
    expect(Object.keys(patch)).toEqual(["trigger"]);
    // The phrase filled the picker; the rule is what's sent.
    expect(patch.trigger).toMatchObject({
      type: "schedule",
      rule: {
        freq: "daily",
        byWeekday: ["MO", "TU", "WE", "TH", "FR"],
        times: ["08:30"],
        timezone: "America/Sao_Paulo",
      },
    });
    expect(screen().getByText(/Rotina salva\. Próxima: /)).toBeTruthy();
    expect(card("Resumo da semana").textContent).toContain("De segunda a sexta, às 08:30");
  });

  test("nothing changed: Salvar just closes", async () => {
    const { state } = await open();
    await menu("Resumo da semana", "Editar");
    await click(
      within(screen().getByRole("dialog", { name: "Editar rotina" })).getByRole("button", { name: "Salvar" }),
    );
    await settle(3);
    expect(state.calls.some((c) => c.method === "routines.update")).toBe(false);
    expect(screen().queryByRole("dialog", { name: "Editar rotina" })).toBeNull();
  });

  test("a routine in UTC starts in my zone, with a hint to keep UTC", async () => {
    const { state } = await open((api) =>
      api.routines.create(ORG_ID, {
        name: "Antiga em UTC",
        agentId: seedState().agents[0]?.id ?? "",
        prompt: "Faça algo.",
        target: { type: "dm" },
        trigger: { type: "schedule", phrase: "toda segunda às 9h", timezone: "UTC" },
      }),
    );
    expect(card("Antiga em UTC").textContent).toContain("(UTC)");
    await menu("Antiga em UTC", "Editar");
    const dialog = screen().getByRole("dialog", { name: "Editar rotina" });
    expect(dialog.textContent).toContain("Esta rotina está em UTC; quer usar o horário de Brasília?");
    expect(within(dialog).getByRole("combobox", { name: "Fuso horário" }).textContent).toContain(
      "Horário de Brasília · UTC−3",
    );
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const patch = state.calls.find((c) => c.method === "routines.update")?.args[1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["trigger"]);
    expect(patch.trigger).toMatchObject({
      type: "schedule",
      rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"], timezone: "America/Sao_Paulo" },
    });
  });

  test("Manter em UTC hides the hint and keeps the zone", async () => {
    const { state } = await open((api) =>
      api.routines.create(ORG_ID, {
        name: "Antiga em UTC",
        agentId: seedState().agents[0]?.id ?? "",
        prompt: "Faça algo.",
        target: { type: "dm" },
        trigger: { type: "schedule", phrase: "toda segunda às 9h", timezone: "UTC" },
      }),
    );
    await menu("Antiga em UTC", "Editar");
    const dialog = screen().getByRole("dialog", { name: "Editar rotina" });
    await click(within(dialog).getByRole("button", { name: "Manter em UTC" }));
    await settle(3);
    expect(dialog.textContent).not.toContain("Esta rotina está em UTC");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "routines.update")).toBe(false);
  });

  test("Duplicar adds a paused copy; Apagar asks, naming it, then removes it", async () => {
    const { state } = await open();
    await menu("Resumo da semana", "Duplicar");
    expect(state.calls.some((c) => c.method === "routines.duplicate")).toBe(true);
    expect(card("Resumo da semana (cópia)").textContent).toContain("Pausada");
    await menu("Resumo da semana", "Apagar");
    const confirm = screen().getByRole("dialog", { name: "Apagar a rotina “Resumo da semana”?" });
    await click(within(confirm).getByRole("button", { name: "Apagar rotina" }));
    await settle(6);
    expect(state.calls.some((c) => c.method === "routines.remove")).toBe(true);
    expect(screen().queryByRole("article", { name: "Resumo da semana" })).toBeNull();
    expect(screen().getByText("Rotina apagada.")).toBeTruthy();
  });

  test("the card's agent is the living symbol with its look", async () => {
    const state = seedState();
    // "Resumo da semana" belongs to the 4th agent of the seed, round-robin.
    const agent = state.agents[3 % state.agents.length];
    if (agent) (agent as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
    await renderApp(`/org/${ORG_ID}/routines`, { api: createFakeApi(state) });
    await settle(8);
    const avatar = card("Resumo da semana").querySelector(".ac-avatar--agent") as HTMLElement;
    expect(avatar.getAttribute("data-accessory")).toBe("hat");
    expect(avatar.style.getPropertyValue("--av-top")).toBeTruthy();
  });
});

describe("routine titles", () => {
  test("a name that is the whole prompt becomes a short title from its first line", async () => {
    const { routineTitle } = await import("@/pages/RoutinesPage");
    expect(routineTitle({ name: "Resumo da semana", prompt: "Resuma a semana." })).toBe("Resumo da semana");
    const prompt =
      "Relatório de visitantes do site wescld com origem, páginas mais vistas e conversões da semana passada\nDetalhes: …";
    const title = routineTitle({ name: prompt, prompt });
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(prompt.startsWith(title.slice(0, -1))).toBe(true);
  });
});
