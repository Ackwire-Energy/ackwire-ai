import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentInput } from "@agenteschat/client";
import { en, ptBR } from "@agenteschat/i18n";
import { cleanup, within } from "@testing-library/react";
import {
  freeHandle,
  handleProblem,
  presetChannels,
  presetLevels,
  ROLE_GROUPS,
  ROLE_IDS,
  ROLE_PRESETS,
  readBudget,
  stepErrors,
} from "@/lib/new-agent";
import { createFakeApi, ENG_ID, fakeMailOf, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
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
    // One short lead under the title.
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Escolha um ponto de partida: o resto a gente preenche.",
    );
  });

  test("the preview waits for a role: none before a pick, then the picked role's agent, on to the next steps", async () => {
    await open();
    const preview = () => screen().queryByRole("complementary", { name: "Prévia do agente" });
    expect(preview()).toBeNull();
    // A pick shows it on the role step itself: Do zero has no name yet, QA starts as Iris.
    await click(screen().getByRole("button", { name: /^Do zero/ }));
    expect(title()).toBe("Qual vai ser o papel?");
    expect(preview()?.textContent).toContain("Seu agente");
    await click(screen().getByRole("button", { name: /^QA/ }));
    expect(preview()?.textContent).toContain("Iris");
    // Headed by its name alone. It says which step it's on: a narrow screen keeps it out of the role step.
    expect(document.querySelector(".newag__cap")?.textContent).toBe("Prévia");
    expect(preview()?.getAttribute("data-step")).toBe("role");
    await proceed();
    expect(preview()?.getAttribute("data-step")).toBe("identity");
  });

  test("what a step needs explained: the instructions' and the budget's ⓘ; the tools keep the approval line", async () => {
    await open();
    await startAs("QA");
    await proceed();
    expect(title()).toBe("O que a Iris faz");
    const hint = (name: string) =>
      document.getElementById(screen().getByRole("button", { name }).getAttribute("aria-describedby") ?? "")
        ?.textContent;
    expect(hint("Sobre O que a Iris faz")).toBe(
      "O contexto da Acme (o que a empresa faz, regras da casa) entra antes destas instruções em toda conversa: escreva aqui só o que é da Iris.",
    );
    expect(document.querySelector(".newag__note")).toBeNull();
    await proceed();
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Escolha até onde a Iris vai em cada app.");
    expect(document.querySelector(".newag__note")?.textContent).toBe(
      "Merge, deploy e rollback sempre pedem aprovação no chat. Quem aprova é Walter.",
    );
    await proceed(2);
    expect(title()).toBe("Modelo e orçamento");
    expect(hint("Sobre Orçamento mensal")).toBe("Ao atingir o limite, a Iris para e avisa. Avisamos Walter aos 80%.");
    expect(screen().getByText(/^Vazio: o padrão do workspace/).textContent).toBe(
      "Vazio: o padrão do workspace (US$ 50).",
    );
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
    expect(title()).toBe("O que a Iris faz");
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toStartWith(
      "Reproduz cada bug relatado antes de abrir uma tarefa.",
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
    // "Automático" comes first and is chosen for every role; the fixed models follow.
    const auto = screen().getByRole("button", { name: /^Automático/ });
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    expect(auto.textContent).toContain("Escolhe o modelo e o esforço para cada tarefa");
    expect(
      screen()
        .getByRole("button", { name: /^Claude Sonnet 5\.5/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    // Real catalog prices; a model without a key can't be picked.
    expect(screen().getByRole("button", { name: /^Claude Sonnet 5\.5/ }).textContent).toContain(
      "US$ 2 / 10 por milhão de tokens",
    );
    const gpt = screen().getByRole("button", { name: /^GPT-5/ });
    expect(gpt.getAttribute("aria-disabled")).toBe("true");
    expect(gpt.textContent).toContain("Precisa de uma chave da OpenAI");
    await click(gpt);
    expect(gpt.getAttribute("aria-pressed")).toBe("false");

    await proceed();
    expect(title()).toBe("Tudo certo com a Iris?");
    expect(document.querySelector(".newag__review")?.textContent).toContain("Automático ·");
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)).toMatchObject({
      name: "Iris",
      handle: "iris",
      role: "QA",
      model: "auto",
      appearance: { color: "violet", eyes: "round", accessory: "headset" },
    });
  });

  test("roles for any team, in groups (tech, customers, operations); Do zero last", async () => {
    await open();
    const step = screen().getByRole("group", { name: "Papel" });
    expect(
      within(step)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["Produto e tecnologia", "Clientes", "Operação"]);
    const names = (heading: string) =>
      within(within(step).getByRole("region", { name: heading }))
        .getAllByRole("button")
        .map((b) => b.querySelector(".newag__role-name b")?.textContent);
    expect(names("Produto e tecnologia")).toEqual(["Dev", "Ops", "QA", "PM"]);
    expect(names("Clientes")).toEqual(["Atendimento", "Vendas", "Marketing", "Conteúdo"]);
    expect(names("Operação")).toEqual(["Dados", "Financeiro", "Pessoas", "Pesquisa", "Assistente"]);
    expect(within(step).getAllByRole("button").at(-1)?.textContent).toContain("Do zero");
    // A preset's first row under the card's padding is the shared face line alone: no class of its own to add room
    // above the face.
    const firstRows = [...step.querySelectorAll(".newag__role:not(.newag__role--blank)")].map(
      (card) => [...card.children].find((c) => !c.classList.contains("newag__check"))?.className,
    );
    expect(firstRows).toEqual(ROLE_IDS.filter((id) => id !== "custom").map(() => "ac-faceline"));

    // A role outside engineering fills the rest the same way.
    await click(within(step).getByRole("button", { name: /^Atendimento/ }));
    await proceed();
    expect((screen().getByLabelText("Nome") as HTMLInputElement).value).toBe("Nina");
    expect((screen().getByLabelText("No chat") as HTMLInputElement).value).toBe("nina");
    await proceed();
    expect(title()).toBe("O que a Nina faz");
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toContain(
      "Enviar mensagem ao cliente, reembolso e desconto só com aprovação.",
    );
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

  test("on a touch screen or at phone width, the instructions' ⌘↵ hint goes with its keys", async () => {
    await open();
    await startAs("PM");
    await proceed();
    expect(title()).toBe("O que o Theo faz");
    const hint = document.querySelector(".newag__hint");
    expect(hint?.querySelectorAll(":scope > kbd.ac-kbd")).toHaveLength(2);
    expect(hint?.textContent).toContain("continua daqui");
    const css = await Bun.file(new URL("../src/responsive.css", import.meta.url).pathname).text();
    const touch = css.split("\n@media (max-width: 760px), (pointer: coarse) {")[1]?.split("\n}")[0] ?? "";
    expect(touch).toMatch(/\.newag__hint:has\(> \.ac-kbd\) \{\s*display: none;/);
  });

  test("Revisar e criar: each section has Editar, which goes to its step", async () => {
    await open();
    await startAs("PM");
    await toReview();
    const content = () => screen().getByRole("heading", { level: 1 }).closest(".newag__content") as HTMLElement;
    expect(title()).toBe("Tudo certo com o Theo?");
    expect(content().textContent).toContain("PM · Organiza tarefas, resumos e o fórum.");
    expect(content().textContent).toContain("@theo");
    // The title says it all: no lead, and no note under the summary.
    expect(content().querySelector(".onb__lead, .newag__note")).toBeNull();
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

  test("model: a fixed model can replace Automático; it is what gets created and reviewed", async () => {
    const state = await open();
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    const sonnet = screen().getByRole("button", { name: /^Claude Sonnet 5\.5/ });
    await click(sonnet);
    expect(sonnet.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen()
        .getByRole("button", { name: /^Automático/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await proceed();
    expect(document.querySelector(".newag__review")?.textContent).toContain("Claude Sonnet 5.5 ·");
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    expect(createdWith(state)?.model).toBe("claude-sonnet-5-5");
  });

  test("plan: with no key, Claude Code on a computer can think; the agent moves there and thinks with it", async () => {
    const plan = (kind: "claude_code" | "codex", available: boolean) => ({
      kind,
      available,
      ...(available ? {} : { reason: "not_installed" as const }),
      experimental: kind === "codex",
      models: [],
      defaultModel: null,
    });
    const state = seedState();
    state.credentials = [];
    state.platformKey = false;
    state.brainMachines = [
      {
        machineId: "machine_mini",
        name: "Mac mini",
        online: true,
        options: [plan("claude_code", true), plan("codex", false)],
      },
    ];
    await open(state);
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    // No key: the API can't think, and Codex isn't on any computer.
    await proceed();
    expect(screen().getAllByText("Escolha um modelo que o workspace pode usar.").length).toBeGreaterThan(0);
    expect(
      screen()
        .getByRole("button", { name: /^Codex.*Indisponível/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    const claude = screen().getByRole("button", { name: /^Claude Code.*Mac mini/ });
    await click(claude);
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    // In the words of the switch it points to, "Atende outras pessoas".
    expect(
      screen().getByText(
        "No plano, a Eva começa atendendo só você. Na página da Eva, você pode escolher se ela atende outras pessoas.",
      ),
    ).toBeTruthy();
    expect(
      screen()
        .getByRole("button", { name: /^Automático/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await proceed();
    expect(document.querySelector(".newag__review")?.textContent).toContain("Claude Code");
    await click(screen().getByRole("button", { name: "Criar Eva" }));
    await settle(8);
    const agentId = state.agents.find((a) => a.handle === "eva")?.id;
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args).toEqual([ORG_ID, agentId, "machine_mini"]);
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      agentId,
      { brain: "claude_code" },
    ]);
  });

  test("budget: empty is the workspace default; zero or text is invalid; a quick amount lights its button", async () => {
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
    // "Outro valor" stays empty: only an amount of its own goes there.
    expect(field.value).toBe("");
    expect(screen().getByRole("button", { name: "US$ 30" }).getAttribute("aria-pressed")).toBe("true");
    await click(screen().getByRole("button", { name: "Padrão do workspace (US$ 50)" }));
    await proceed();
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    expect(createdWith(state)?.monthlyBudgetUsd).toBeNull();
  });

  test("connected mailboxes are in 'Ferramentas e acesso', off by default; the chosen level is saved", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const mail = fakeMailOf.get(api);
    if (!mail) throw new Error("no mail fake");
    mail.accounts = [
      {
        id: "mail-1",
        provider: "imap",
        via: "imap",
        address: "ola@acme.com.br",
        label: "Atendimento",
        status: "active",
        lastError: null,
        preset: "icloud",
        createdAt: new Date().toISOString(),
        offActions: [],
        askActions: [],
        aliases: [],
        defaultFrom: null,
        agents: [],
      },
    ];
    await renderApp(`/org/${ORG_ID}/agents/new`, { api });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    expect(title()).toBe("Ferramentas e acesso");
    const levels = within(screen().getByRole("list", { name: "Conectores e níveis" }));
    const box = levels.getByRole("radiogroup", { name: "Nível em ola@acme.com.br" });
    expect(within(box).getByRole("radio", { name: "Sem acesso" }).getAttribute("aria-checked")).toBe("true");
    await click(within(box).getByRole("radio", { name: "Ler" }));
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const saved = state.calls.find((c) => c.method === "mail.setAgent");
    expect(saved?.args.slice(2)).toEqual(["mail-1", expect.objectContaining({ level: "read", canDelete: false })]);
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
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com a Iris" });
    expect(
      within(audience)
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(audience).getByRole("radio", { name: /^Só algumas pessoas/ }));
    expect(document.body.textContent).toContain("João sempre pode, como responsável.");
    await click(screen().getAllByLabelText(/Walter/)[0] as HTMLElement);
    await proceed(2);
    // The owner and who can talk each under a label of their own, in the review and the preview: under "Responde a",
    // next to who can talk, the owner would read as whom the agent replies to.
    const labelled = (rows: string, label: string, value: string) =>
      [...document.querySelectorAll(rows)].map((r) => [
        r.querySelector(label)?.textContent,
        r.querySelector(value)?.textContent,
      ]);
    expect(labelled(".newag__review .newag__rv", ".newag__rv-k", ".newag__rv-v").slice(5, 7)).toEqual([
      ["Responsável", "João"],
      ["Quem pode falar", "Walter e João"],
    ]);
    expect(labelled(".newag__pv-sec", ".newag__pv-label", ".newag__chips").slice(2, 4)).toEqual([
      ["Responsável", "João"],
      ["Quem pode falar", "Walter e João"],
    ]);
    expect(screen().getByRole("complementary", { name: "Prévia do agente" }).textContent).not.toContain("Responde a");
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
    const audience = screen().getByRole("radiogroup", { name: "Quem pode falar com a Iris" });
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
    // Title, lead and the buttons: no cards after them.
    expect(document.querySelector(".newag__born")?.nextElementSibling).toBeNull();
    // Every step is done; none can be reopened.
    expect(railStep("Papel").disabled).toBe(true);
    await click(screen().getByRole("button", { name: "Criar outro agente" }));
    expect(title()).toBe("Qual vai ser o papel?");
    // The draft starts over, so the preview waits for a role again.
    expect(screen().queryByRole("complementary", { name: "Prévia do agente" })).toBeNull();
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

  test("presets: levels by catalog connector, channels by name", () => {
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
  });

  test("roles: each one in exactly one group, with its texts in both languages and its own starter name", () => {
    const grouped = ROLE_GROUPS.flatMap((g) => g.roles as readonly string[]);
    expect(grouped.toSorted()).toEqual(ROLE_IDS.filter((id) => id !== "custom").toSorted());
    for (const dict of [ptBR, en]) {
      const roles = dict.newAgent.roles as Record<
        string,
        { name: string; agent?: string; desc: string; instructions: string }
      >;
      for (const id of grouped) {
        expect(roles[id]?.name).toBeTruthy();
        expect(roles[id]?.agent).toBeTruthy();
        expect(roles[id]?.desc).toBeTruthy();
        expect(roles[id]?.instructions).toBeTruthy();
      }
      const agents = grouped.map((id) => roles[id]?.agent);
      expect(new Set(agents).size).toBe(agents.length);
      for (const g of ROLE_GROUPS) expect((dict.newAgent.roleGroups as Record<string, string>)[g.id]).toBeTruthy();
    }
    // Money starts read-only.
    expect(ROLE_PRESETS.finance.levels).toEqual({ stripe: "read", paypal: "read", square: "read", drive: "read" });
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
