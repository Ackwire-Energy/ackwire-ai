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
/** "Fica com esse time?": only these join Ada. */
const keepOnly = async (...keep: string[]) => {
  for (const name of ["Theo · PM", "Lia · Pesquisa", "Atlas · Ops"]) {
    const card = screen().getByRole("button", { name: new RegExp(name) });
    if ((card.getAttribute("aria-pressed") === "true") !== keep.includes(name)) await click(card);
  }
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
async function open(
  path: string,
  setup: Partial<ComputerSetup> | null,
  state = seedState(),
  api = createFakeApi(state),
) {
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
    // The plans by their makers' marks, in one row under the screens, with no generic key icon.
    const plans = on.querySelector(".setup-plans") as HTMLElement;
    expect(plans.textContent).toBe(
      "Os agentes podem pensar com o seu próprio plano de IA, com login neste computador. Não precisa de chave de API.",
    );
    const stack = within(plans).getByRole("img", { name: "Claude, ChatGPT, GLM, Kimi e outros planos de IA" });
    expect([...stack.querySelectorAll(".ac-brand")].map((m) => m.getAttribute("data-mark"))).toEqual([
      "claude",
      "openai",
      "zai",
      "kimi",
    ]);
    expect(on.querySelector(".setup-facts li:last-child")?.textContent).toBe(
      "Uma tela para cada agente, com o navegador e os arquivos dele",
    );
    // One icon only, the screens': the plans are led by their makers' marks, never a generic key.
    expect(on.querySelectorAll("svg.ac-icon")).toHaveLength(1);
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
    // Whoever creates the workspace owns it: the email is theirs. The team isn't made yet: nothing says the page
    // can be closed.
    expect(step.textContent).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
    expect(step.textContent).not.toContain("Pode fechar esta página");
    expect(step.textContent).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    // The plans: one general line led by four makers' marks, on its own row under the facts.
    const plans = step.querySelector(".setup-wait > .setup-plans:last-child") as HTMLElement;
    expect(plans.textContent).toBe(
      "Os agentes podem pensar com o seu próprio plano de IA, com login neste computador. Não precisa de chave de API.",
    );
    expect(within(plans).getByRole("img", { name: "Claude, ChatGPT, GLM, Kimi e outros planos de IA" })).toBeTruthy();
    // Every line starts with its icon or its makers' marks, set on the line's first line of text.
    const lines = [...step.querySelectorAll(".setup-progress--line, .setup-line, .setup-facts li, .onb__status")];
    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(line.classList.contains("ac-iconline")).toBe(true);
      expect(line.firstElementChild?.matches("svg.ac-icon, canvas.ac-pixspin, .ac-brand, .ac-brand-stack")).toBe(true);
    }
    // One lead size above the hairline, so those lines' words start in one column (the status under them is a box
    // of its own).
    for (const line of lines.filter((l) => !l.matches(".onb__status, .setup-plans"))) {
      const lead = line.firstElementChild as HTMLElement;
      expect(lead.style.width).toBe("14px");
    }
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

  /**
   * A new person's onboarding up to the computer step, the import skipped. Its agents get the workspace's computer
   * once it's ready (`computer.ready`), as the server gives it to them; nobody connected it.
   */
  const toComputerStep = async (setup: Partial<ComputerSetup>) => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    // The server says every workspace gets its own: never "opcional", from the first step on.
    state.authConfig = { workspaceComputer: true };
    const api = createFakeApi(state);
    const computer = { ready: setup.state === "ready" };
    const brainOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await brainOf(orgId, agentId)),
      computer: computer.ready ? { machineId: "m-1", name: "Computador da Acme Saúde", online: true } : null,
      machines: [],
      ownSignIn: false,
    });
    api.machines.aiAccounts = async () => ({
      accounts: [],
      computers: computer.ready
        ? [
            {
              machineId: "m-1",
              name: "Computador da Acme Saúde",
              online: true,
              mine: false,
              canAdd: true,
              keys: true,
              brains: { claude_code: true, codex: true },
            },
          ]
        : [],
    });
    const r = await open("/onboarding", setup, state, api);
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).not.toContain("opcional");
    for (const [label, value] of [
      ["Nome", "Acme Saúde"],
      ["Contexto", "Clínicas."],
    ] as const) {
      await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
      await click(screen().getByRole("button", { name: "Continuar" }));
    }
    await click(screen().getByRole("button", { name: "Pular esta etapa" }));
    const reported = async (next: Partial<ComputerSetup>) => {
      r.machines.setSetup(next);
      computer.ready = next.state === "ready";
      await act(async () => r.services.queryClient.invalidateQueries());
      await settle(6);
    };
    return { ...r, state, computer, reported };
  };

  test("a computer kept ready: every line follows it in seconds, and nothing waits once it's ready", async () => {
    const r = await toComputerStep({ state: "preparing", specs: SPECS, notifyByEmail: true });
    const step = () => (document.querySelector(".onb__workspace-computer") as HTMLElement).textContent ?? "";
    // Nothing reported yet: no time is promised.
    expect(step()).toContain("Preparando o computador.");
    expect(step()).not.toContain("minutos");

    // One kept ready is handed over: the last step, seconds away. The steps before it are done, it is under way.
    await r.reported({ state: "preparing", step: "connecting", secondsLeft: 6, specs: SPECS, notifyByEmail: true });
    const bars = [...document.querySelectorAll(".onb__workspace-computer .ac-steps__bar")];
    expect(bars.map((b) => [b.getAttribute("data-done"), b.hasAttribute("data-current")])).toEqual([
      ["true", false],
      ["true", false],
      ["true", false],
      ["false", true],
    ]);
    expect(step()).toContain("Passo 4 de 4 · Conectando ao seu workspace");
    expect(step()).toContain("Quase pronto…");

    await r.reported({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    expect(document.body.textContent).toContain("Num computador só deste workspace, que já está pronto.");
    expect(step()).toContain("Pronto. Os agentes trabalham nele.");
    expect(step()).toContain("Os agentes podem pensar com o seu próprio plano de IA");
    expect(step()).not.toMatch(/Quando ficar pronto|Pode seguir/);
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Pronto");

    // The team is made before the AI: the AI step opens on Claude's sign-in, on the workspace's computer.
    await click(screen().getByRole("button", { name: "Continuar" }));
    await click(screen().getByRole("button", { name: "Criar 3 agentes" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: /^Agentes e IA/ })).toBeTruthy();
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await click(screen().getByRole("button", { name: "Conectar depois" }));
    await settle(6);
    await click(screen().getByRole("button", { name: "Pular esta etapa" }));
    // Done: how far it is in the tile's big type, whose it is under it.
    const tile = [...document.querySelectorAll(".onb__summary > *")].find((c) =>
      c.textContent?.startsWith("Computador"),
    );
    expect(tile?.querySelector(".onb__stat")?.textContent).toBe("Pronto");
    expect(tile?.querySelector(".onb__stat-of")?.textContent).toBe("Computador da Acme Saúde");
  });

  test("the AI step while it's prepared: Claude's panel waits in place, then turns on by itself; nothing starts before a click", async () => {
    const r = await toComputerStep({
      state: "preparing",
      step: "installing",
      secondsLeft: 600,
      specs: SPECS,
      notifyByEmail: true,
      expectedReadyAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    // Every step keeps asking about it while it's on its way.
    const interval = (key: string) => {
      const query = r.services.queryClient
        .getQueryCache()
        .findAll()
        .find((q) => q.queryKey.at(-1) === key && q.getObserversCount() > 0);
      const every = query?.observers[0]?.options.refetchInterval;
      return typeof every === "function" && query ? every(query) : every;
    };
    expect(interval("computer-setup")).toBe(5000);
    await keepOnly("Theo · PM");
    await click(screen().getByRole("button", { name: "Criar 1 agente" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    // Ada and Theo exist before any AI: leaving now leaves a whole team.
    expect(r.state.calls.filter((c) => c.method === "agents.create")).toHaveLength(2);
    const panel = () => screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(panel().textContent).toContain("Passo 3 de 4 · Instalando os programas");
    expect(panel().textContent).toContain("Faltam uns 10 min");
    // Here the team exists: closing the page is safe, and the email says so.
    expect(panel().textContent).toContain(
      "Avisamos você em walter@acme.com.br quando ele ficar pronto. Pode fechar esta página.",
    );
    expect(panel().textContent).toContain("Você entra aqui assim que ele ficar pronto.");
    const signIn = () => within(panel()).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement;
    expect(signIn().disabled).toBe(true);
    // A plan for Ada, the guide, first; Theo is the other choice.
    expect(within(panel()).getByRole("combobox", { name: "Para qual agente" }).textContent).toContain("Ada");
    // No socket here: the agent's view and the accounts are asked again every 5 s until something is connected.
    expect(interval("brain")).toBe(5000);
    expect(interval("ai-accounts")).toBe(5000);
    expect(screen().getByRole("button", { name: "Continuar" }).hasAttribute("disabled")).toBe(true);
    expect(screen().getByRole("button", { name: "Conectar depois" })).toBeTruthy();

    // It turns ready while the person watches: said in place, and the sign-in comes on. Still nothing started.
    r.machines.setSetup({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    r.computer.ready = true;
    await act(async () => r.services.queryClient.invalidateQueries());
    await settle(8);
    expect(panel().textContent).toContain("O Computador da Acme Saúde está pronto.");
    expect(signIn().disabled).toBe(false);
    expect(interval("computer-setup")).toBe(false);
    expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(0);
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(signIn());
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [r.state.calls.find((c) => c.method === "agents.create")?.args[0], "m-1", "claude_code"],
    ]);
  });

  test("the AI step while it waits for capacity or has a problem: an API key now is one click away", async () => {
    for (const setup of [{ state: "waiting", reason: "capacity" }, { state: "problem" }] as const) {
      const r = await toComputerStep({ ...setup, specs: SPECS, notifyByEmail: true });
      await click(screen().getByRole("button", { name: "Continuar" }));
      await click(screen().getByRole("button", { name: "Criar 3 agentes" }));
      const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
      expect(panel.textContent).toContain(
        setup.state === "problem" ? "Algo deu errado ao preparar o computador" : "Está demorando mais que o normal.",
      );
      await click(within(panel).getByRole("button", { name: "Usar uma chave de API agora" }));
      const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
      expect(
        within(picker)
          .getByRole("button", { name: /^Chave de API/ })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(screen().getByRole("region", { name: "Chave de API" })).toBeTruthy();
      expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(0);
      cleanup();
    }
  });

  test("a step's column stays where it opened as its content changes; a resize or the next step places it", async () => {
    // Where the column sits, centered, as the browser lays it out.
    let top = 120;
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return this.classList.contains("onb__body") ? ({ top, y: top } as DOMRect) : real.call(this);
    };
    try {
      const r = await toComputerStep({ state: "preparing", step: "installing", secondsLeft: 330, specs: SPECS });
      const column = () => document.querySelector(".onb__body") as HTMLElement;
      expect(column().style.marginTop).toBe("120px");
      // The computer's progress grows and shrinks it (centered, it would move): the question and Back stay put.
      top = 60;
      await r.reported({ state: "preparing", step: "connecting", secondsLeft: 6, specs: SPECS });
      await r.reported({ state: "ready", machineId: "m-1", specs: SPECS });
      expect(column().style.marginTop).toBe("120px");
      await act(async () => window.dispatchEvent(new Event("resize")));
      expect(column().style.marginTop).toBe("60px");
      top = 80;
      await click(screen().getByRole("button", { name: "Continuar" }));
      expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
      expect(column().style.marginTop).toBe("80px");
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
  });
});
