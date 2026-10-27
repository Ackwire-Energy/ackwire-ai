import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus, JevKey } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const OFF: JevKey = { source: null, hint: null, state: "off", month: { decisions: 0, costUsd: 0 } };
const ON: JevKey = { source: "settings", hint: "9f2c", state: "ok", month: { decisions: 1240, costUsd: 0.13 } };
const routed = (by: NonNullable<AiStatus["routing"]>["by"]): AiStatus => ({
  any: true,
  agents: [],
  routing: { by, mine: by === "plans" ? "plan" : by, model: null, noSmallModel: null },
  apiKey: false,
});

const open = async (patch: Partial<ReturnType<typeof seedState>>) => {
  const state = seedState(patch);
  const r = await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
  await settle(5);
  return { ...r, state };
};
const card = () => screen().getByRole("region", { name: "Jev" });
const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const field = () => within(card()).getByLabelText("Cole aqui") as HTMLInputElement;
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

describe("Jev's key in Configurações › Contas de IA", () => {
  test("nobody but the server's owner sees it: who picks, and no Jev", async () => {
    await open({ aiStatus: routed("plans") });
    const section = screen().getByRole("region", { name: "Quem escolhe os agentes" });
    expect(section.textContent).toContain("Cada plano escolhe só nas mensagens de quem o conectou.");
    expect(within(section).getByRole("link", { name: "Como os agentes são escolhidos" }).getAttribute("href")).toBe(
      "https://agentes.chat/help/who-answers?lang=pt-BR",
    );
    expect(screen().queryByRole("region", { name: "Jev" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/jev|typesafe/i);
  });

  test("off: why it helps, then its steps in place, each with its link; a short key isn't offered", async () => {
    const { state } = await open({ aiStatus: routed("rules"), jev: OFF });
    // Under who picks now, in the same section.
    const section = screen().getByRole("region", { name: "Quem escolhe os agentes" });
    expect(section.contains(card())).toBe(true);
    expect(section.textContent).toContain("Os agentes respondem a menções, respostas e continuações.");
    expect(card().querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("typesafe");
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(card().textContent).toContain("Ajuda os agentes a trabalhar em equipe.");
    for (const why of [
      "Escolhe quem responde Mesmo sem @menção.",
      "Organiza a memória Percebe repetições ditas de outro jeito.",
      "Enxerga a tela Os agentes acham botões pela descrição.",
    ])
      expect(card().textContent).toContain(why);
    expect(within(card()).getByRole("link", { name: "Como o Jev funciona" }).getAttribute("href")).toBe(
      "https://agentes.chat/help/jev?lang=pt-BR",
    );
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();

    await click(within(card()).getByRole("button", { name: "Configurar o Jev" }));
    const site = within(card()).getByRole("link", { name: "Abrir a TypeSafe" });
    const keys = within(card()).getByRole("link", { name: "Abrir as chaves de API" });
    expect([site.getAttribute("href"), keys.getAttribute("href")]).toEqual([
      "https://console.typesafe.ai",
      "https://console.typesafe.ai/keys",
    ]);
    // The way on is TypeSafe's console until a key is typed.
    expect(site.className).toContain("ac-btn--primary");
    // What it costs, behind the first step's ⓘ, in this language's numbers.
    const hint = within(card()).getByRole("button", { name: "Sobre Crie uma conta na TypeSafe e adicione crédito" });
    expect(document.getElementById(hint.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "O Jev é pré-pago: US$ 0,042 por milhão de tokens. Escolher quem responde custa cerca de US$ 0,0001.",
    );
    expect(field().type).toBe("password");
    expect(field().getAttribute("placeholder")).toBe("A sua chave da TypeSafe");
    expect(document.getElementById(field().getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Cifrada neste servidor. Nunca mais aparece.",
    );
    const save = () => within(card()).getByRole("button", { name: "Salvar chave" });
    await type(field(), "ts_1234");
    expect(save().hasAttribute("disabled")).toBe(true);
    expect(site.className).not.toContain("ac-btn--primary");
    await type(field(), "  ts_live_9f2c  ");
    expect(save().hasAttribute("disabled")).toBe(false);
    await click(save(), 6);
    expect(calls(state, "system.saveJev")).toEqual([["ts_live_9f2c"]]);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).toContain("Termina em 9f2c");
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();
    // The key itself is never on the page.
    expect(document.body.innerHTML).not.toContain("ts_live_9f2c");
  });

  test("a key TypeSafe refuses: said under the field, nothing kept; Cancel closes the steps", async () => {
    const { state } = await open({ jev: OFF, jevVerdicts: { ts_wrong_0000: "invalid" } });
    await click(within(card()).getByRole("button", { name: "Configurar o Jev" }));
    await type(field(), "ts_wrong_0000");
    await click(within(card()).getByRole("button", { name: "Salvar chave" }), 6);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field().getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "A TypeSafe não aceitou esta chave. Copie de novo na página de chaves.",
    );
    expect(state.jev?.source).toBeNull();
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    // No toast on top of the line under the field.
    expect(document.querySelector(".ac-toast")).toBeNull();
    await type(field(), "ts_other_1111");
    expect(field().hasAttribute("aria-invalid")).toBe(false);
    await click(within(card()).getByRole("button", { name: "Cancelar" }));
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();
  });

  test("on: its last 4 and this month's use; Trocar a chave asks only for the new key; Apagar asks first", async () => {
    const { state } = await open({ aiStatus: routed("jev"), jev: ON });
    expect(screen().getByRole("region", { name: "Quem escolhe os agentes" }).textContent).toContain(
      "O Jev escolhe quem responde cada mensagem sem menção.",
    );
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).toContain("Chave da TypeSafe");
    expect(card().textContent).toContain("Termina em 9f2c · 1.240 decisões este mês · US$ 0,13");
    expect(card().querySelector(".ac-setnote")).toBeNull();

    await click(within(card()).getByRole("button", { name: "Trocar a chave" }));
    // Steps ② and ③ only, numbered 1 and 2.
    expect(within(card()).queryByRole("link", { name: "Abrir a TypeSafe" })).toBeNull();
    expect([...card().querySelectorAll(".agp-addacct__step > i")].map((n) => n.textContent)).toEqual(["1", "2"]);
    await type(field(), "ts_new_key_7777");
    await click(within(card()).getByRole("button", { name: "Salvar chave" }), 6);
    expect(calls(state, "system.saveJev")).toEqual([["ts_new_key_7777"]]);
    expect(card().textContent).toContain("Termina em 7777");

    await click(within(card()).getByRole("button", { name: "Apagar" }));
    const ask = screen().getByRole("dialog", { name: "Remover a chave do Jev?" });
    expect(ask.textContent).toContain("Os agentes continuam trabalhando sem ele.");
    expect(calls(state, "system.removeJev")).toEqual([]);
    await click(within(ask).getByRole("button", { name: "Apagar" }), 6);
    expect(calls(state, "system.removeJev")).toEqual([[]]);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(within(card()).getByRole("button", { name: "Configurar o Jev" })).toBeTruthy();
  });

  test("a key not accepted, out of credit: the state, what to do, and the console where it's done", async () => {
    const { state } = await open({ jev: { ...ON, state: "invalid", month: { decisions: 0, costUsd: 0 } } });
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Chave recusada");
    expect(card().querySelector(".ac-chip")?.className).toContain("ac-chip--waiting");
    expect(card().textContent).toContain("A TypeSafe não aceitou esta chave. Crie uma nova.");
    // No month line with nothing this month.
    expect(card().textContent).not.toContain("este mês");
    expect(within(card()).getByRole("link", { name: "Abrir as chaves de API" }).getAttribute("href")).toBe(
      "https://console.typesafe.ai/keys",
    );
    expect(within(card()).getByRole("button", { name: "Trocar a chave" })).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Apagar" })).toBeNull();
    cleanup();

    state.jev = { ...ON, state: "no_credit" };
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Sem crédito");
    expect(card().textContent).toContain("Adicione crédito na TypeSafe. O Jev volta sozinho.");
    expect(within(card()).getByRole("link", { name: "Abrir a TypeSafe" }).getAttribute("href")).toBe(
      "https://console.typesafe.ai",
    );
    await click(within(card()).getByRole("button", { name: "Verificar de novo" }));
    expect(calls(state, "system.checkJev")).toEqual([[]]);
  });

  test("a limit or an outage is no state of the card: TypeSafe's view says On", async () => {
    // The server shows `ok` while TypeSafe limits requests or doesn't answer.
    await open({ jev: ON });
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).not.toMatch(/limite|fora do ar/i);
  });

  test("from the server's settings: no Replace or Delete, where it's set instead; refused: the keys page alone", async () => {
    const env: JevKey = { ...ON, source: "env" };
    const { state } = await open({ jev: env });
    expect(card().textContent).toContain("Definida nas configurações deste servidor (TYPESAFE_API_KEY).");
    expect(within(card()).queryByRole("button", { name: "Trocar a chave" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(
      within(card())
        .queryAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Como o Jev funciona"]);
    cleanup();

    state.jev = { ...env, state: "invalid" };
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    expect(card().textContent).toContain(
      "A TypeSafe não aceitou esta chave. Troque nas configurações deste servidor (TYPESAFE_API_KEY).",
    );
    expect(
      within(card())
        .queryAllByRole("button")
        .map((b) => b.textContent),
    ).not.toContain("Trocar a chave");
    expect(within(card()).getByRole("link", { name: "Abrir as chaves de API" })).toBeTruthy();
  });

  test("in English", async () => {
    const { services } = await open({ aiStatus: routed("model"), jev: { ...ON, state: "no_credit" } });
    await act(async () => {
      await services.i18n.changeLanguage("en");
    });
    await settle(3);
    const section = screen().getByRole("region", { name: "Who picks the agents" });
    expect(within(section).getByRole("link", { name: "How agents are picked" })).toBeTruthy();
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Out of credit");
    expect(card().textContent).toContain("TypeSafe key");
    expect(card().textContent).toContain("Ends in 9f2c · 1,240 decisions this month · US$ 0.13");
    expect(card().textContent).toContain("Add credit at TypeSafe. Jev resumes by itself.");
    expect(within(card()).getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(within(card()).getByRole("link", { name: "Open TypeSafe" })).toBeTruthy();
  });

  test("?open=jev lands on it, scrolled to and focused", async () => {
    const state = seedState({ jev: ON });
    const { router } = await renderApp("/?open=jev", { api: createFakeApi(state) });
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/keys`);
    expect(router.state.location.hash).toBe("jev");
    expect(document.activeElement).toBe(card());
  });
});
