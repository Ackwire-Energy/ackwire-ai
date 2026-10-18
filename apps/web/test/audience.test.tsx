import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent } from "@agenteschat/client";
import { audienceNotice, audienceSummary, canEditAudience, canTalk } from "@agenteschat/client/lib/audience";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { proceed, startAs } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });
const go = async (path: string, state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
/** Ada answers only her owner (João); I am Walter. */
const onlyOwner = () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.audience = { mode: "owner", userIds: [] };
  return state;
};

describe("Quem pode falar com a Ada", () => {
  test("Configurações: everyone by default; Só algumas pessoas → pick → Salvar sends the audience", async () => {
    const state = await go(`agents/${ADA_ID}?tab=settings&sec=audience`);
    const section = screen().getByRole("region", { name: "Quem pode falar com a Ada" });
    const group = within(section).getByRole("radiogroup", { name: "Quem pode falar com a Ada" });
    expect(within(group).getByRole("radio", { name: /^Todos do workspace/ }).getAttribute("aria-checked")).toBe("true");
    await click(within(group).getByRole("radio", { name: /^Só algumas pessoas/ }));
    // The owner (João) always can; he isn't in the list.
    expect(section.textContent).toContain("João sempre pode, como responsável.");
    await click(within(section).getAllByLabelText(/Walter/)[0] as HTMLElement);
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "people", userIds: ["u-walter"] },
    });
  });

  test("an agent that doesn't answer me: chip, no @ suggestion, DM composer off with the notice", async () => {
    await go(`c/${ENG_ID}`, onlyOwner());
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    const sidebarAda = within(nav).getByRole("link", { name: /^Ada/ });
    expect(sidebarAda.textContent).toContain("Pessoal");
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await typeIn(box, "oi @a");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const names = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(names.some((n) => n.includes("Ada"))).toBe(false);
    expect(names.some((n) => n.includes("Atlas"))).toBe(true);
    cleanup();
    await go(`dm/agent/${ADA_ID}`, onlyOwner());
    const dm = screen().getByRole("combobox", { name: /Mensagem para Ada/ }) as HTMLTextAreaElement;
    expect(dm.disabled).toBe(true);
    expect(screen().getByText("A Ada só responde a João.")).toBeTruthy();
  });

  test("Criar agente: everyone by default, sent with the new agent", async () => {
    const state = await go("agents/new");
    await startAs("PM");
    await proceed(3);
    const group = screen().getByRole("radiogroup", { name: "Quem pode falar com o Theo" });
    expect(
      within(group)
        .getByRole("radio", { name: /Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(group).getByRole("radio", { name: /Só o responsável/ }));
    expect(document.body.textContent).toContain("Só Walter fala com o Theo.");
    await proceed(2);
    await click(screen().getByRole("button", { name: "Criar Theo" }));
    await settle(6);
    expect(
      (state.calls.find((c) => c.method === "agents.create")?.args[1] as { audience?: unknown } | undefined)?.audience,
    ).toEqual({ mode: "owner", userIds: [] });
  });
});

describe("audience rules", () => {
  const i18n = createI18n("pt-BR");
  const t = i18n.t.bind(i18n);
  const theo = (over: Partial<Agent>): Agent => ({
    id: "a",
    name: "Theo",
    handle: "theo",
    role: "",
    instructions: "",
    model: "m",
    ownerUserId: "u1",
    hasCredential: false,
    monthlyBudgetUsd: null,
    createdAt: "",
    ...over,
  });
  const names: Record<string, string> = { u1: "Walter", u2: "Ana", u3: "Bia", u4: "Caio" };
  const nameOf = (id: string) => names[id];

  test("notice and summary", () => {
    expect(audienceNotice(t, theo({}), nameOf)).toBe("");
    expect(audienceNotice(t, theo({ audience: { mode: "owner", userIds: [] } }), nameOf)).toBe(
      "O Theo só responde a Walter.",
    );
    expect(audienceNotice(t, theo({ audience: { mode: "people", userIds: ["u2"] } }), nameOf)).toBe(
      "O Theo só responde a Walter e Ana.",
    );
    // From the directory list (no user ids): "algumas pessoas".
    expect(audienceNotice(t, theo({ audienceMode: "people", canTalk: false }), nameOf)).toBe(
      "O Theo só responde a algumas pessoas.",
    );
    expect(audienceSummary(t, theo({ audience: { mode: "owner", userIds: [] } }), nameOf)).toBe("Só Walter");
    expect(audienceSummary(t, theo({ audience: { mode: "people", userIds: ["u2", "u3", "u4"] } }), nameOf)).toBe(
      "Walter, Ana e mais 2",
    );
  });

  test("who can talk and who can edit", () => {
    expect(canTalk(theo({}))).toBe(true);
    expect(canTalk(theo({ canTalk: false }))).toBe(false);
    expect(canEditAudience("member", theo({}), "u1")).toBe(true);
    expect(canEditAudience("member", theo({}), "u2")).toBe(false);
    expect(canEditAudience("admin", theo({}), "u2")).toBe(true);
  });

  test("agent.unavailable: the notice shows for me and the 'pensando…' goes away", async () => {
    const { createStreamsStore } = await import("@/realtime/context");
    const store = createStreamsStore();
    store.expect("c1", "m1", ["a"]);
    expect(Object.keys(store.get().streams.runs)).toHaveLength(1);
    store.unavailable({
      type: "agent.unavailable",
      agentId: "a",
      channelId: "c1",
      threadId: null,
      messageId: "m1",
      text: "O Theo só responde a Walter.",
    });
    expect(Object.keys(store.get().streams.runs)).toHaveLength(0);
    expect(store.get().notices.c1?.map((n) => n.text)).toEqual(["O Theo só responde a Walter."]);
  });
});
