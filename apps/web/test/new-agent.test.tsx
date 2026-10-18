import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentInput } from "@agenteschat/client";
import { cleanup, within } from "@testing-library/react";
import {
  freeHandle,
  handleProblem,
  presetChannels,
  presetLevels,
  presetModel,
  readBudget,
  stepErrors,
} from "@/lib/new-agent";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import {
  click,
  continueButton,
  pick,
  press,
  proceed,
  railStep,
  startAs,
  title,
  toReview,
  typeIn,
} from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const createdWith = (state: ReturnType<typeof seedState>) =>
  state.calls.find((c) => c.method === "agents.create")?.args[1] as AgentInput | undefined;

describe("Criar agente: steps", () => {
  test("a focused flow: the rail with its steps instead of the sidebar; × and Cancelar leave", async () => {
    await open();
    expect(screen().queryByRole("navigation", { name: "Navegação do workspace" })).toBeNull();
    const rail = screen().getByRole("navigation", { name: "Passos para criar o agente" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "1Papel",
      "2Identidade",
      "3Instruções",
      "4Ferramentas e acesso",
      "5Onde e quem",
      "6Modelo e orçamento",
      "7Revisar e criar",
    ]);
    expect(railStep("Papel").getAttribute("aria-current")).toBe("step");
    expect(railStep("Identidade").disabled).toBe(true);
    expect(screen().getByRole("link", { name: "Sair sem criar" }).getAttribute("href")).toBe(`/org/${ORG_ID}`);
    expect(screen().getByRole("link", { name: "Cancelar" }).getAttribute("href")).toBe(`/org/${ORG_ID}`);
    expect(screen().getByRole("complementary", { name: "Prévia do agente" }).textContent).toContain("Seu agente");
  });

  test("a role is required; picking one fills the rest (name, @, look, instructions, levels, channels, model)", async () => {
    const state = await open();
    expect(title()).toBe("Qual vai ser o papel?");
    await click(continueButton());
    expect(title()).toBe("Qual vai ser o papel?");
    expect(screen().getAllByText("Escolha um papel ou comece do zero.").length).toBeGreaterThan(0);
    expect(continueButton().getAttribute("aria-disabled")).toBe("true");

    await startAs("QA");
    expect(title()).toBe("Quem é");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Iris");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("iris");
    expect(screen().getByRole("button", { name: "Violeta" }).getAttribute("aria-pressed")).toBe("true");
    expect(
      screen()
        .getByRole("button", { name: /^Headset/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const preview = screen().getByRole("complementary", { name: "Prévia do agente" });
    expect(preview.textContent).toContain("Iris");
    expect(preview.textContent).toContain("@iris");

    await proceed();
    expect(title()).toBe("O que o Iris faz");
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toStartWith(
      "Reproduz cada bug relatado antes de abrir issue.",
    );

    await proceed();
    const github = within(screen().getByRole("list", { name: "Conectores e níveis" })).getByRole("radiogroup", {
      name: "Nível em GitHub",
    });
    // QA reads GitHub (the preset), nothing writes.
    expect(within(github).getByRole("radio", { name: "Ler" }).getAttribute("aria-checked")).toBe("true");

    await proceed();
    // The role's channels among yours: #eng for QA, not #general.
    expect(screen().getByRole("checkbox", { name: "#eng" }).getAttribute("aria-checked")).toBe("true");
    expect(screen().getByRole("checkbox", { name: "#general" }).getAttribute("aria-checked")).toBe("false");

    await proceed();
    expect(
      screen()
        .getByRole("button", { name: /^Claude Sonnet 5\.5/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // Real catalog prices; a model without a key can't be picked.
    expect(screen().getByRole("button", { name: /^Claude Sonnet 5\.5/ }).textContent).toContain(
      "US$ 2 / 10 por milhão de tokens",
    );
    const gpt = screen().getByRole("button", { name: /^GPT-5/ });
    expect(gpt.getAttribute("aria-disabled")).toBe("true");
    expect(gpt.textContent).toContain("Adicione uma chave da OpenAI para usar");
    await click(gpt);
    expect(gpt.getAttribute("aria-pressed")).toBe("false");

    await proceed();
    expect(title()).toBe("Tudo certo com o Iris?");
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({
      name: "Iris",
      handle: "iris",
      role: "QA",
      model: "claude-sonnet-5-5",
      appearance: { color: "violet", eyes: "round", accessory: "headset" },
    });
  });

  test("Dev starts as Ada, whose @ is taken: the error suggests a free one and blocks the step", async () => {
    await open();
    await startAs("Dev");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("ada");
    expect(document.body.textContent).toContain("@ada já é de outro agente ou pessoa. Que tal @ada-2?");
    await click(continueButton());
    expect(title()).toBe("Quem é");
    await typeIn(screen().getByLabelText("No chat"), "Ada 2!");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("ada2");
    // A person's @ is taken too.
    await typeIn(screen().getByLabelText("No chat"), "joao");
    expect(document.body.textContent).toContain("@joao já é de outro agente ou pessoa.");
    await typeIn(screen().getByLabelText("No chat"), "-x");
    expect(document.body.textContent).toContain("Use de 2 a 32 letras minúsculas");
    await typeIn(screen().getByLabelText("No chat"), "ada-dev");
    // The name no longer drives a handle someone edited.
    await typeIn(screen().getByLabelText("Nome"), "Ada Maria");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("ada-dev");
    await proceed();
    expect(title()).toBe("O que a Ada Maria faz");
  });

  test("an empty name and @ only complain after trying to go on", async () => {
    await open();
    await startAs("Do zero");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("Dê um nome ao agente.");
    await click(continueButton());
    expect(title()).toBe("Quem é");
    expect(document.body.textContent).toContain("Dê um nome ao agente.");
    expect(document.body.textContent).toContain("Escolha um @ para o agente.");
    await typeIn(screen().getByLabelText("Nome"), "Íris B.");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("irisb");
    expect(document.body.textContent).not.toContain("Dê um nome ao agente.");
  });

  test("keyboard: Enter continues, ⌘/Ctrl+Enter inside the instructions, Esc goes back; visited steps are clickable", async () => {
    await open();
    await click(screen().getByRole("button", { name: /^PM/ }));
    await press(document.body, "Enter");
    expect(title()).toBe("Quem é");
    // Enter in a field continues.
    await press(screen().getByLabelText("Nome"), "Enter");
    expect(title()).toBe("O que o Theo faz");
    // A plain Enter in the instructions is a new line; ⌘↵ / Ctrl+↵ continues.
    const ta = screen().getByLabelText("Instruções");
    await press(ta, "Enter");
    expect(title()).toBe("O que o Theo faz");
    await press(ta, "Enter", { ctrlKey: true });
    expect(title()).toBe("Ferramentas e acesso");
    // Esc in a field only leaves it; Esc elsewhere goes back.
    await press(screen().getByRole("heading", { level: 1 }), "Escape");
    expect(title()).toBe("O que o Theo faz");
    // Steps already reached are on the rail; later ones aren't yet.
    expect(railStep("Ferramentas e acesso").disabled).toBe(false);
    expect(railStep("Onde e quem").disabled).toBe(true);
    await click(railStep("Papel"));
    expect(title()).toBe("Qual vai ser o papel?");
    expect(railStep("Papel").getAttribute("aria-current")).toBe("step");
    await click(railStep("Ferramentas e acesso"));
    expect(title()).toBe("Ferramentas e acesso");
    // Esc on the first step stays.
    await click(railStep("Papel"));
    await press(document.body, "Escape");
    expect(title()).toBe("Qual vai ser o papel?");
  });

  test("Revisar e criar: each section has Editar, which goes to its step", async () => {
    await open();
    await startAs("PM");
    await toReview();
    const content = () => screen().getByRole("heading", { level: 1 }).closest(".newag__content") as HTMLElement;
    expect(title()).toBe("Tudo certo com o Theo?");
    expect(content().textContent).toContain("PM · Organiza tarefas, resumos e o fórum.");
    expect(content().textContent).toContain("@theo");
    await click(within(content()).getByRole("button", { name: "Editar Modelo e custo" }));
    expect(title()).toBe("Modelo e orçamento");
    await proceed();
    await click(within(content()).getByRole("button", { name: "Editar Instruções" }));
    expect(title()).toBe("O que o Theo faz");
  });
});

describe("Criar agente: what gets created", () => {
  test("levels: one access write after creation, the chosen connectors kept", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(2);
    const github = within(screen().getByRole("list", { name: "Conectores e níveis" })).getByRole("radiogroup", {
      name: "Nível em GitHub",
    });
    await click(within(github).getByRole("radio", { name: "Ler e escrever" }));
    // Writing: the sensitive action shows as asking for approval.
    expect(screen().getByRole("list", { name: "Conectores e níveis" }).textContent).toContain(
      "Fazer merge pede aprovação",
    );
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts).toHaveLength(1);
    const body = puts[0]?.args[2] as { connectors: Record<string, boolean> };
    expect(body.connectors).toEqual({ "conn-gh": true });
  });

  test("budget: empty is the workspace default; zero or text is invalid; a quick amount fills it", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    expect(document.body.textContent).toContain("Vazio: o padrão do workspace (US$ 50).");
    const field = screen().getByLabelText("Orçamento mensal (US$)") as HTMLInputElement;
    await typeIn(field, "0");
    await click(continueButton());
    expect(title()).toBe("Modelo e orçamento");
    expect(screen().getAllByText("Use um valor maior que zero.").length).toBeGreaterThan(0);
    await typeIn(field, "abc");
    expect(screen().getAllByText("Use um valor maior que zero.").length).toBeGreaterThan(0);
    await click(screen().getByRole("button", { name: "US$ 30" }));
    expect(field.value).toBe("30");
    expect(screen().getByRole("button", { name: "US$ 30" }).getAttribute("aria-pressed")).toBe("true");
    await typeIn(field, "");
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)?.monthlyBudgetUsd).toBeNull();
  });

  test("a set budget is sent; the key defaults to the workspace's (credentialId null)", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(4);
    expect(screen().getByRole("combobox", { name: "Chave" }).textContent).toContain("Chave padrão do workspace");
    await typeIn(screen().getByLabelText("Orçamento mensal (US$)"), "25,5");
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({ monthlyBudgetUsd: 25.5, credentialId: null });
  });

  test("owner, who can talk to it and channels are sent", async () => {
    const state = await open();
    await startAs("QA");
    await proceed(3);
    expect(title()).toBe("Onde trabalha e com quem");
    await click(screen().getByRole("checkbox", { name: "#general" }));
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /^João/);
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com o Iris" });
    expect(
      within(audience)
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(audience).getByRole("radio", { name: /^Só algumas pessoas/ }));
    expect(document.body.textContent).toContain("João sempre pode, como responsável.");
    await click(screen().getAllByLabelText(/Walter/)[0] as HTMLElement);
    await proceed(2);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({
      ownerUserId: "u-joao",
      audience: { mode: "people", userIds: ["u-walter"] },
    });
    const channels = state.calls.find((c) => c.method === "agents.setChannels")?.args[2] as { channelId: string }[];
    expect(channels.map((c) => c.channelId).sort()).toEqual([ENG_ID, GENERAL_ID].sort());
  });

  test("'Só o responsável' needs an owner", async () => {
    await open();
    await startAs("QA");
    await proceed(3);
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /Sem responsável/);
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com o Iris" });
    await click(within(audience).getByRole("radio", { name: /^Só o responsável/ }));
    await click(continueButton());
    expect(title()).toBe("Onde trabalha e com quem");
    expect(screen().getAllByText("Defina um responsável para usar esta opção.").length).toBeGreaterThan(0);
    await click(within(audience).getByRole("radio", { name: /^Todos do workspace/ }));
    await proceed();
    expect(title()).toBe("Modelo e orçamento");
  });

  test("the created moment: go to the channel, open the profile, create another", async () => {
    const state = await open();
    await startAs("QA");
    await toReview();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const agentId = state.agents.at(-1)?.id;
    expect(screen().getByRole("heading", { name: "Iris entrou no time" })).toBeTruthy();
    expect(document.body.textContent).toContain("Já está em #eng. Mencione @iris numa conversa para começar.");
    expect(screen().getByRole("link", { name: "Ir para o #eng" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${ENG_ID}`,
    );
    expect(screen().getByRole("link", { name: "Abrir perfil" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${agentId}`,
    );
    expect(document.body.textContent).toContain("Avisos com Walter");
    // Every step is done; none can be reopened.
    expect(railStep("Papel").disabled).toBe(true);
    await click(screen().getByRole("button", { name: "Criar outro agente" }));
    expect(title()).toBe("Qual vai ser o papel?");
    await startAs("Do zero");
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("");
  });
});

describe("new-agent rules", () => {
  const taken = new Set(["ada", "ada-2", "joao"]);

  test("handles: shape, taken, next free", () => {
    expect(handleProblem("", taken)).toBe("empty");
    expect(handleProblem("a", taken)).toBe("format");
    expect(handleProblem("-ab", taken)).toBe("format");
    expect(handleProblem("ada", taken)).toBe("taken");
    expect(handleProblem("iris_2", taken)).toBeNull();
    expect(freeHandle("ada", taken)).toBe("ada-3");
  });

  test("budget: empty = default, positive amounts, the rest invalid", () => {
    expect(readBudget("")).toEqual({ amount: null, invalid: false });
    expect(readBudget("40,5")).toEqual({ amount: 40.5, invalid: false });
    expect(readBudget("0").invalid).toBe(true);
    expect(readBudget("-3").invalid).toBe(true);
    expect(readBudget("dez").invalid).toBe(true);
  });

  test("presets: levels by catalog connector, channels by name, the model family when usable", () => {
    const items = [
      { id: "c1", def: { id: "github" } },
      { id: "c2", def: { id: "notion" } },
      { id: "c3", def: null },
    ];
    expect(presetLevels("dev", items)).toEqual({ c1: "write", c2: "none", c3: "none" });
    expect(presetLevels("pm", items)).toEqual({ c1: "read", c2: "write", c3: "none" });
    expect(presetLevels("custom", items)).toEqual({ c1: "none", c2: "none", c3: "none" });
    const chans = [
      { id: "1", name: "Engenharia" },
      { id: "2", name: "general" },
      { id: "3", name: "incidentes" },
    ];
    expect(presetChannels("dev", chans)).toEqual(["1"]);
    expect(presetChannels("ops", chans)).toEqual(["3"]);
    expect(presetChannels("custom", chans)).toEqual([]);
    const models = [
      { id: "claude-sonnet-5-5", label: "", provider: "anthropic", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
      { id: "claude-haiku-5-5", label: "", provider: "anthropic", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
      { id: "gpt-5", label: "", provider: "openai", inputUsdPerMTok: 1, outputUsdPerMTok: 10 },
    ];
    const anthropic = (m: { provider: string }) => m.provider === "anthropic";
    expect(presetModel("haiku", models, anthropic)).toBe("claude-haiku-5-5");
    expect(presetModel("opus", models, anthropic, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(presetModel("sonnet", models, (m) => m.provider === "openai")).toBe("gpt-5");
  });

  test("what each step needs", () => {
    const base = {
      role: "qa" as const,
      name: "Iris",
      handle: "iris",
      taken,
      ownerUserId: "u1",
      audience: { mode: "everyone" as const, userIds: [] },
      budget: "",
      modelOk: true,
    };
    expect(stepErrors("role", { ...base, role: null })).toEqual([{ field: "role", code: "required" }]);
    expect(stepErrors("identity", { ...base, name: " ", handle: "ada" })).toEqual([
      { field: "name", code: "required" },
      { field: "handle", code: "taken" },
    ]);
    expect(stepErrors("where", { ...base, ownerUserId: null, audience: { mode: "owner", userIds: [] } })).toEqual([
      { field: "audience", code: "noOwner" },
    ]);
    // "Algumas pessoas" with nobody picked is fine while there's an owner (the owner always can).
    expect(stepErrors("where", { ...base, audience: { mode: "people", userIds: [] } })).toEqual([]);
    expect(stepErrors("model", { ...base, budget: "0", modelOk: false })).toEqual([
      { field: "model", code: "unavailable" },
      { field: "budget", code: "invalid" },
    ]);
    expect(stepErrors("review", base)).toEqual([]);
  });
});
