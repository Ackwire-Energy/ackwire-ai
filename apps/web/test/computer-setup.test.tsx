import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup, Machine } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SPECS = { cpus: 4, memoryGb: 8, diskGb: 100 };
/** No system, address, provider or tool list on these screens (ADR 0056 §10). */
const TECHNICAL = /Linux|\bIP\b|IPv4|Contabo|VPS|Debian|Chrome|\bgit\b|Outro sistema/;
const NOTICE = "O computador do workspace";

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

/** The workspace's own computer as the server lists it: named by the server, no system, nobody paired it. */
const WORKSPACE_COMPUTER: Partial<Machine> & { name: string } = {
  name: "Computador da Acme",
  kind: "managed",
  os: "other",
  arch: "",
  hostname: "",
  workspace: null,
  pairedBy: null,
  mode: "system",
};

/** A combobox's options, opened. */
async function optionsOf(combobox: HTMLElement) {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await settle(2);
  const names = screen()
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
  await act(async () => fireEvent.keyDown(document.activeElement ?? combobox, { key: "Escape" }));
  await settle(2);
  return names;
}

/** Acme where the workspace's computer is ready (Ada on it) and the server has no cloud computer. */
async function readyWorkspace(path: string, patch: Partial<Machine> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  const m = machines.pair({ ...WORKSPACE_COMPUTER, ...patch });
  machines.setSetup({ state: "ready", machineId: m.id, specs: SPECS });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  const settings = api.sandbox.settings;
  api.sandbox.settings = async (orgId) => ({ ...(await settings(orgId)), available: false });
  const r = await renderApp(path.replace("$machineId", m.id), { api });
  await settle(10);
  return { ...r, state, api, m };
}

/** The app at `path` where the workspace gets its own computer (`setup`), or where people pair theirs (null). */
async function open(path: string, setup: Partial<ComputerSetup> | null, state = seedState()) {
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  if (setup) machines.setSetup(setup);
  const r = await renderApp(path, { api });
  await settle(8);
  // The onboarding opens no socket.
  const socket = r.sockets.sockets.at(-1);
  if (socket) await act(async () => socket.open());
  const push = async (event: Partial<ComputerSetup> & { type?: string }) => {
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: {
          type: "machine.provisioning",
          state: "preparing",
          step: null,
          reason: null,
          since: new Date().toISOString(),
          etaSeconds: null,
          specs: SPECS,
          machineId: null,
          ...event,
        },
      }),
    );
    await settle(6);
  };
  return { ...r, api, machines, socket, push };
}

describe("the workspace's computer on its way: the notice on top of the work area", () => {
  test("how far it is and who waits for it, live, closed until the state changes, gone once ready", async () => {
    const { push } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { state: "waiting", reason: "approval" });
    const notice = () => screen().getByRole("region", { name: NOTICE });
    expect(notice().textContent).toContain("Preparando o computador da Acme");
    expect(notice().textContent).toContain("Seu computador fica pronto em breve. Avisamos você.");
    expect(notice().textContent).toContain("Ada e Atlas esperam por ele");
    expect(notice().textContent).not.toMatch(TECHNICAL);

    await push({ state: "preparing", step: "starting" });
    expect(notice().textContent).toContain("Ligando");
    expect(notice().textContent).not.toContain("Avisamos você");

    // Closed: it stays closed for this step, and comes back for the next one.
    await click(within(notice()).getByRole("button", { name: "Ocultar" }));
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    await push({ state: "preparing", step: "starting" });
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    await push({ state: "preparing", step: "installing" });
    expect(notice().textContent).toContain("Instalando os programas");

    await push({ state: "problem" });
    expect(notice().textContent).toContain("Algo deu errado ao preparar o computador");
    await push({ state: "ready", machineId: "00000000-0000-4000-8000-000000000999" });
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("where people connect their own computers, nothing changes: no notice", async () => {
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, null);
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });
});

describe("Configurações → Computadores: the workspace's own computer", () => {
  test("its card instead of the cloud's: steps, size, one user per agent; ready, online with its agents", async () => {
    const { push, machines } = await open(`/org/${ORG_ID}/settings/computers`, {
      state: "preparing",
      step: "starting",
      specs: SPECS,
    });
    const card = () => screen().getByRole("region", { name: "Computador da Acme" });
    expect(card().textContent).toContain("Sendo preparado");
    expect(card().textContent).toContain("Passo 2 de 4 · Ligando");
    expect(card().textContent).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    expect(card().textContent).toContain("Um usuário para cada agente");
    expect(card().textContent).not.toMatch(TECHNICAL);
    // Not the cloud computer's cards: there is none here.
    expect(screen().queryByText("Na nuvem")).toBeNull();
    expect(screen().queryByRole("region", { name: "Computador na nuvem" })).toBeNull();

    await push({ state: "waiting", reason: "capacity" });
    expect(card().textContent).toContain("Demorando mais");
    expect(card().textContent).toContain("Está demorando mais que o normal. Nada se perde");

    // Its first hello: ready, its row among the computers, the agents on it.
    const m = machines.pair({ ...WORKSPACE_COMPUTER, agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }] });
    await push({ state: "ready", machineId: m.id });
    expect(card().textContent).toContain("Online");
    expect(card().textContent).toContain("Usado por Ada");
    // The page says what the agents' computers are here: the workspace's own, not the cloud's.
    expect(document.body.textContent).toContain("o computador do próprio workspace, ou um computador seu");
    expect(card().textContent).not.toContain("Passo");
    expect(card().textContent).toContain("Um usuário para cada agente");
    // People's own computers are listed apart: the workspace's isn't one of them.
    const mine = screen().getByRole("region", { name: "Seus computadores" });
    expect(mine.textContent).toContain("Nenhum computador seu ainda");

    // Its page: its name, size and agents; no system, folder, Remove or "Para liberar mais".
    await click(within(card()).getByRole("link", { name: "Computador da Acme" }));
    await settle(6);
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    const page = document.body.textContent ?? "";
    expect(page).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    expect(page).not.toMatch(TECHNICAL);
    expect(page).not.toContain("Pasta:");
    expect(page).not.toContain("Para liberar mais");
    const actions = screen().getByRole("button", { name: "Ações de Computador da Acme" });
    actions.focus();
    await act(async () => {
      fireEvent.keyDown(actions, { key: "Enter" });
      fireEvent.keyUp(actions, { key: "Enter" });
    });
    await settle(2);
    const menu = screen().getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Renomear" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Remover" })).toBeNull();
  });

  test("its page: nothing to turn off that nobody here could turn back on; plain words when something fails", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers/$machineId`, {
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
      access: {
        folders: [{ path: "/srv/shared", agents: [ADA_ID] }],
        tools: { claude: true, codex: true, commands: true, browser: true, desktop: true },
      },
      browser: {
        available: false,
        version: null,
        chrome: null,
        reason: "ETXTBSY: text file is busy; run `agentes-runner browser install`",
      },
      desktopUse: { available: false, reason: "Missing packages: run `sudo apt-get install xdotool`" },
    });
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    expect(screen().getAllByText("Ligado").length).toBeGreaterThan(0);
    expect(screen().queryAllByRole("button", { name: /^Desligar/ })).toEqual([]);
    expect(screen().queryByRole("button", { name: "Ações de shared" })).toBeNull();
    const page = document.body.textContent ?? "";
    expect(page).toContain("Não está funcionando neste computador agora.");
    expect(page).toContain("Precisa de ajuda? Fale com quem cuida deste servidor.");
    for (const word of ["ETXTBSY", "agentes-runner", "apt-get", "Preferências", "Linux"])
      expect(page).not.toContain(word);
  });

  test("an agent on it: no word about allowing more on the computer itself", async () => {
    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, {
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
    });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    expect(pc.textContent).toContain("Usa só a própria pasta no Computador da Acme.");
    expect(pc.textContent).not.toContain("por quem o conectou");
  });

  test("ready, on a server with no cloud computer: no Nuvem to pick; an agent without one says so", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers`);
    const card = screen().getByRole("region", { name: "Qual computador cada agente usa" });
    const ada = within(card).getByRole("combobox", { name: "Computador de Ada" });
    expect(ada.textContent).toContain("Computador da Acme");
    expect((await optionsOf(ada)).join(" | ")).not.toContain("Nuvem");
    const atlas = within(card).getByRole("combobox", { name: "Computador de Atlas" });
    expect(atlas.textContent).toContain("Nenhum computador");
    expect(card.textContent).not.toContain("Nuvem");
    expect(within(card).queryByRole("button", { name: /Ações do PC/ })).toBeNull();
  });

  test("ready: Onde trabalha offers the workspace's computer, never a cloud this server doesn't have", async () => {
    const { state } = await readyWorkspace(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Nenhum computador");
    expect(work.textContent).not.toContain("nuvem");
    await click(screen().getByRole("button", { name: "Mudar onde trabalha" }));
    const d = screen().getByRole("dialog", { name: "Onde o Atlas trabalha?" });
    const radios = within(d)
      .getAllByRole("radio")
      .map((r) => r.textContent ?? "");
    expect(radios.join(" | ")).not.toContain("Nuvem");
    await click(within(d).getByRole("radio", { name: /^Computador da Acme/ }));
    await click(within(d).getByRole("button", { name: "Usar o Computador da Acme" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget" && c.args[1] === ATLAS_ID)?.args[2]).toBeTruthy();
  });

  test("which computer each agent uses: the workspace's computer while it is on its way, no cloud PC controls", async () => {
    await open(`/org/${ORG_ID}/settings/computers`, { state: "waiting", reason: "approval" });
    const card = screen().getByRole("region", { name: "Qual computador cada agente usa" });
    expect(card.textContent).toContain("Computador da Acme");
    expect(card.textContent).not.toContain("Nuvem");
    expect(within(card).queryByRole("button", { name: /Ações do PC/ })).toBeNull();
  });
});

describe("an agent's computer while the workspace's is on its way", () => {
  test("Como trabalha says where it will work and why it waits", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, { state: "waiting", reason: "approval" });
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    expect(work.textContent).toContain("Pronto em breve");
    expect(work.textContent).not.toContain("nuvem");
    expect(document.body.textContent).toContain("A Ada começa a usar assim que ele ficar pronto.");
  });

  test("once ready, the agent works on the workspace's computer, by its name", async () => {
    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    expect(document.body.textContent).not.toContain("A Ada começa a usar");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("moving an agent there while it is on its way: what it will be, when, and its brain kept", async () => {
    const state = seedState();
    state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    machines.pair({
      id: "machine_1",
      name: "MacBook",
      os: "darwin",
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
      browser: { available: true, version: "1", chrome: null, reason: null },
    });
    machines.setSetup({ state: "preparing", step: "starting" });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet" });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
    await settle(10);
    await click(screen().getByRole("button", { name: "Mudar onde trabalha" }));
    const d = screen().getByRole("dialog", { name: "Onde a Ada trabalha?" });
    const option = within(d).getByRole("radio", { name: /^Computador da Acme/ });
    expect(option.textContent).toContain("Ligando");
    await click(option);
    expect(d.textContent).toContain("A Ada começa a usar assim que ele ficar pronto.");
    expect(d.textContent).not.toContain("Volta para o modelo da organização");
    expect(d.textContent).not.toContain("Deixa de navegar");
    expect(within(d).queryByRole("button", { name: "Usar a Nuvem" })).toBeNull();
    await click(within(d).getByRole("button", { name: "Usar o Computador da Acme" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "sandbox.setTarget").at(-1)?.args).toEqual([ORG_ID, ADA_ID, null]);
    expect(state.calls.some((c) => c.method === "agents.setBrain")).toBe(false);
    expect(document.body.textContent).toContain("A Ada agora trabalha no Computador da Acme.");
  });

  test("Configurações › its computer: the progress, and no cloud PC to create", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { state: "preparing", step: "installing" });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    expect(pc.textContent).toContain("Passo 3 de 4 · Instalando os programas");
    expect(pc.textContent).toContain("A Ada começa a usar assim que ele ficar pronto.");
    expect(pc.textContent).not.toMatch(TECHNICAL);
    expect(within(pc).queryByRole("button", { name: /Criar PC/ })).toBeNull();
  });
});

describe("a computer connected in system mode (each agent its own user)", () => {
  test("its page says so instead of the folder it was connected from, and allowing takes its administrator", async () => {
    const { machines, router, socket } = await open(`/org/${ORG_ID}/settings/computers`, null);
    const box = machines.pair({ name: "Servidor", os: "linux", mode: "system", workspace: "/root/agentes" });
    const laptop = machines.pair({ name: "Notebook", os: "linux", workspace: "/home/ana/agentes" });
    const mac = machines.pair({ name: "MacBook", os: "darwin", workspace: "/Users/ana/agentes" });
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: { type: "machine.paired", machineId: box.id, name: box.name },
      }),
    );
    await settle(6);
    const page = async (id: string) => {
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/computers/$machineId", params: { orgId: ORG_ID, machineId: id } }),
      );
      await settle(8);
      return document.body.textContent ?? "";
    };

    const system = await page(box.id);
    expect(system).toContain("Cada agente trabalha com o próprio usuário, na própria pasta.");
    expect(system).not.toContain("/root/agentes");
    expect(system).toContain("Liberar é no próprio computador, no Terminal dele, como administrador:");
    expect(system).toContain("sudo agentes-runner folders allow <pasta> --agent <agente>");
    expect(system).not.toContain("app agentes no Mac");

    // One user for every agent: the folder it was connected from is theirs, and the Terminal needs no sudo.
    const single = await page(laptop.id);
    expect(single).toContain("Pasta: /home/ana/agentes");
    expect(single).toContain("Liberar é no próprio computador, no Terminal dele:");
    expect(single).not.toContain("sudo");
    expect(single).not.toContain("app agentes no Mac");

    // A Mac keeps the app first, the Terminal as the way without it.
    const onMac = await page(mac.id);
    expect(onMac).toContain("abra o app agentes no Mac");
    expect(onMac).toContain("Sem o app? No Terminal do computador:");
  });
});

describe("the onboarding where the workspace gets its own computer", () => {
  test("the computer step shows it being prepared: nothing to choose, nothing to skip, go on", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    await open("/onboarding", { state: "waiting", reason: "approval", specs: SPECS }, state);
    const type = async (label: string, value: string) => {
      await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
      await settle(2);
    };
    const button = (name: string) => screen().getByRole("button", { name });
    await type("Nome", "Acme Saúde");
    await click(button("Continuar"));
    await settle(4);
    await type("Contexto", "Clínicas.");
    await click(button("Continuar"));
    await settle(4);
    await click(button("Pular esta etapa"));
    await settle(6);

    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    const step = document.querySelector(".onb__workspace-computer") as HTMLElement;
    expect(step.textContent).toContain("Computador da Acme Saúde");
    expect(step.textContent).toContain("Seu computador fica pronto em breve. Avisamos você.");
    expect(step.textContent).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    expect(step.textContent).toContain("Pode seguir: os agentes começam a usar assim que ele ficar pronto.");
    expect(step.textContent).not.toMatch(TECHNICAL);
    // No cloud PC or computer of mine to pick, and nothing to skip.
    expect(screen().queryByRole("button", { name: /Computador na nuvem/ })).toBeNull();
    expect(screen().queryByRole("button", { name: "Pular esta etapa" })).toBeNull();
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    await click(button("Continuar"));
    await settle(4);
    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
  });
});
