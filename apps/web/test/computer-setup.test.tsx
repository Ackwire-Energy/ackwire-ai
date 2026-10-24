import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup } from "@agenteschat/client";
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
    const m = machines.pair({
      name: "Acme",
      kind: "managed",
      os: "other",
      arch: "",
      hostname: "",
      workspace: null,
      pairedBy: null,
      mode: "system",
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
    });
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
    const actions = screen().getByRole("button", { name: "Ações de Acme" });
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

  test("once ready, the agent works on the workspace's computer, called by its workspace's name", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    const m = machines.pair({ name: "Acme", kind: "managed", os: "other", arch: "", hostname: "", mode: "system" });
    machines.setSetup({ state: "ready", machineId: m.id, specs: SPECS });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
    await settle(10);
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
