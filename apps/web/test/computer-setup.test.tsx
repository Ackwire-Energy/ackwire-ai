import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup, Machine } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
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
          requestedAt: new Date(Date.now() - 30_000).toISOString(),
          expectedReadyAt: null,
          secondsLeft: null,
          secondsWaited: 30,
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
  test("how far it is, the time left and who waits for it, live, closed until the state changes, gone once ready", async () => {
    const { push } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { state: "waiting", reason: "capacity" });
    const notice = () => screen().getByRole("region", { name: NOTICE });
    expect(notice().textContent).toContain("Preparando o computador da Acme");
    expect(notice().textContent).toContain("Está demorando mais que o normal. Nada se perde.");
    expect(notice().textContent).toContain("Ada e Atlas esperam por ele");
    expect(notice().textContent).not.toMatch(TECHNICAL);
    // No promise to everyone: only owners hear of the email, and not here.
    expect(notice().textContent).not.toContain("Avisamos");

    await push({ state: "preparing", step: "installing", secondsLeft: 330 });
    expect(notice().textContent).toContain(
      "Passo 3 de 4 · Instalando os programas · faltam uns 6 min · Ada e Atlas esperam por ele",
    );
    await push({ state: "preparing", step: "starting" });
    expect(notice().textContent).toContain("Passo 2 de 4 · Iniciando · Ada e Atlas esperam por ele");

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
    expect(card().textContent).toContain("Passo 2 de 4 · Iniciando");
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
    // The page says what the agents' computer is here in one line, and its card doesn't say it again; nothing
    // else to connect or pick.
    const words = document.body.textContent ?? "";
    expect(words).toContain("Onde os agentes trabalham: um computador só deste workspace, sempre ligado.");
    for (const said of ["sempre ligado", "onde os agentes trabalham"])
      expect(words.toLowerCase().split(said)).toHaveLength(2);
    expect(card().textContent).not.toContain("Passo");
    expect(card().textContent).toContain("Um usuário para cada agente");
    expect(screen().queryByRole("region", { name: "Outros computadores" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Conectar outro computador" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();

    // Its page: its name, size and agents, Open beside each; no system, folder, Remove or "Para liberar mais".
    await click(within(card()).getByRole("link", { name: "Computador da Acme" }));
    await settle(6);
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Abrir: Computador da Ada" })).toBeTruthy();
    const page = document.body.textContent ?? "";
    expect(page).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    expect(page.toLowerCase().split("sempre ligado")).toHaveLength(2);
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

  test("its page: one card of what is on it, nothing to turn off that nobody here could turn back on", async () => {
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
    const on = screen().getByRole("region", { name: "Neste computador" });
    // What each agent has there, true for whoever reads it (Open shows only for who may watch): its browser and
    // files are on its screen.
    expect(on.textContent).toContain("Uma tela para cada agente, com o navegador e os arquivos dele");
    expect(on.textContent).toContain("O Claude Code e o Codex, prontos para cada agente entrar");
    expect(on.textContent).toContain("Planos de código da Z.ai (GLM), Kimi, MiniMax e OpenCode");
    expect(on.textContent).not.toMatch(/Abrir|assumir o controle/);
    // Not the cards of a computer someone connected: folders, tools, browser, apps.
    for (const name of ["Pastas liberadas", "Ferramentas", "Navegador", "Apps nas telas dos agentes"])
      expect(screen().queryByRole("region", { name })).toBeNull();
    expect(screen().queryAllByRole("button", { name: /^Desligar/ })).toEqual([]);
    expect(screen().queryByRole("button", { name: "Ações de shared" })).toBeNull();
    const page = document.body.textContent ?? "";
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

  test("ready: every agent works on the workspace's computer, with nothing to pick", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers`);
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();
    expect(screen().queryByRole("combobox", { name: "Computador de Ada" })).toBeNull();
    cleanup();

    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    // A static line: no chevron, no picker.
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
    expect(work.textContent).not.toMatch(/nuvem/i);
  });

  test("who hears when it's ready: owners of a server that sends email; anyone else reads it shows here", async () => {
    const wait = { state: "waiting", reason: "capacity", notifyByEmail: true } as const;
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent ?? "";
    await open(`/org/${ORG_ID}/settings/computers`, wait);
    expect(card()).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto. Pode fechar esta página.");
    expect(card()).not.toContain("Aparece aqui");
    cleanup();

    // Only owners get the email: nobody else is promised it.
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await open(`/org/${ORG_ID}/settings/computers`, wait, member);
    expect(card()).toContain("Aparece aqui assim que ficar pronto.");
    expect(card()).not.toContain("Avisamos");
    cleanup();

    // A server that sends no email promises none, to owners either.
    await open(`/org/${ORG_ID}/settings/computers`, { ...wait, notifyByEmail: false });
    expect(card()).toContain("Aparece aqui assim que ficar pronto.");
    expect(card()).not.toContain("Avisamos");
  });

  test("while it is on its way: no picker either, the wait in its place", async () => {
    await open(`/org/${ORG_ID}/settings/computers`, { state: "waiting", reason: "capacity" });
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();
    expect(screen().getByRole("region", { name: "Computador da Acme" }).textContent).toContain("Demorando mais");
  });
});

describe("an agent's computer while the workspace's is on its way", () => {
  test("Como trabalha says where it will work and why it waits", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, { state: "waiting", reason: "capacity" });
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    expect(work.textContent).toContain("Demorando mais");
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
    await open("/onboarding", { state: "waiting", reason: "capacity", specs: SPECS, notifyByEmail: true }, state);
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
    expect(step.textContent).toContain("Está demorando mais que o normal. Nada se perde.");
    // Whoever creates the workspace owns it: the email is theirs.
    expect(step.textContent).toContain(
      "Avisamos você em walter@acme.com.br quando ele ficar pronto. Pode fechar esta página.",
    );
    expect(step.textContent).toContain("O Claude Code e o Codex já vêm nele.");
    expect(step.textContent).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    // The lead says where, and the rail says how far: never "opcional".
    expect(document.body.textContent).toContain("Num computador só deste workspace, que está sendo preparado agora.");
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Demorando mais");
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).not.toContain("opcional");
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

  test("a hold put on the new workspace meanwhile: the hold speaks, with no time and no email", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    const r = await open(
      "/onboarding",
      { state: "preparing", step: "installing", secondsLeft: 330, notifyByEmail: true },
      state,
    );
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
    const step = () => (document.querySelector(".onb__workspace-computer") as HTMLElement).textContent ?? "";
    expect(step()).toContain("Faltam uns 6 min");

    // Held (a review of the new sign-up, say): its provisioner waits too, so no countdown and no promise.
    const me = state.me;
    if (!me) throw new Error("no me");
    state.me = {
      ...me,
      organizations: me.organizations.map((o) =>
        o.name === "Acme Saúde" ? { ...o, standing: { state: "hold", reason: null } } : o,
      ),
    };
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.me }));
    await settle(6);
    expect(step()).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(step()).not.toContain("Faltam");
    expect(step()).not.toContain("Avisamos");
  });
});
