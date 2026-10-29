import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const HOST = "00000000-0000-4000-8000-0000000009ee";

interface Options {
  /** The workspace gets its own computer (the Cloud), this far; else people connect theirs. */
  setup?: Partial<ComputerSetup>;
  /** This server's own computer, on in this workspace. */
  host?: boolean;
  /** This server has Daytona's sandboxes. */
  daytona?: boolean;
  signupOpen?: boolean;
  role?: "owner" | "member";
}

async function computers(path: string, o: Options = {}) {
  const state = seedState();
  state.authConfig = { ...state.authConfig, signupOpen: o.signupOpen ?? false };
  if (o.role && state.me?.organizations[0]) state.me.organizations[0].role = o.role;
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (!machines) throw new Error("no fake machines");
  if (o.setup) machines.setSetup(o.setup);
  if (o.host) {
    machines.pair({ id: HOST, name: "", kind: "host", os: "linux", mode: "system", pairedBy: null });
    machines.setHost({ machineId: HOST, on: true });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, HOST);
  }
  const settings = api.sandbox.settings;
  api.sandbox.settings = async (orgId) => ({ ...(await settings(orgId)), available: o.daytona === true });
  const r = await renderApp(path, { api });
  await settle(10);
  return { ...r, state, api, machines };
}

const body = () => (document.querySelector(".settings__body") as HTMLElement).textContent ?? "";
const region = (name: string) => screen().queryByRole("region", { name });

describe("Configurações → Computadores on the Cloud: one computer, nothing to connect or pick", () => {
  test("the lead line and the workspace's card, and nothing else", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`, { setup: { step: "installing", specs: null } });
    expect(body()).toContain("Onde os agentes trabalham: um computador só deste workspace, sempre ligado.");
    expect(region("Computador da Acme")).toBeTruthy();
    for (const name of [
      "Outros computadores",
      "Conectar outro computador",
      "Qual computador cada agente usa",
      "Sandboxes da Daytona",
    ])
      expect(region(name)).toBeNull();
    expect(screen().queryByRole("link", { name: /^Baixar o app para/ })).toBeNull();
    // The page on how people's own computers work is self-host's alone.
    expect(screen().queryByRole("link", { name: "Como os computadores funcionam" })).toBeNull();
    // Drawn as a server, never as the cloud.
    expect(document.querySelector(".setup-card canvas.ac-computer")?.getAttribute("data-kind")).toBe("linux");
    expect(body()).not.toMatch(/na nuvem|seu computador|desligad|parear|terminal/i);
  });

  test("its page, for a member: Open only beside the agents they may watch, and no word on who changes it", async () => {
    const { api, machines } = await computers(`/org/${ORG_ID}/settings/computers`, {
      setup: { state: "ready" },
      role: "member",
    });
    const m = machines.pair({
      name: "Computador da Acme",
      kind: "managed",
      os: "other",
      pairedBy: null,
      canManage: false,
    });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    await api.sandbox.setTarget(ORG_ID, ATLAS_ID, m.id);
    // Atlas's computer isn't this member's to watch: its dialog would only say so.
    fakeBrowserOf.get(api)?.forbidden.add(ATLAS_ID);
    cleanup();
    await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(10);
    expect(screen().getByRole("button", { name: "Abrir: Computador da Ada" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Abrir: Computador do Atlas" })).toBeNull();
    // Nobody in the workspace changes what its own computer allows: no note that only admins do.
    expect(document.body.textContent).not.toContain("mudam o que este computador libera");
  });

  test("before the server says which edition this is, neither's cards: a failed answer says so and asks again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ step: "installing" });
    const answer = api.machines.computerSetup;
    let down = true;
    api.machines.computerSetup = async (orgId) => {
      if (down) throw new TypeError("Failed to fetch");
      return answer(orgId);
    };
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(10);
    for (const name of [
      "Computador deste servidor",
      "Outros computadores",
      "Conectar outro computador",
      "Qual computador cada agente usa",
    ])
      expect(region(name)).toBeNull();
    expect(body()).not.toContain("install.sh");
    expect(body()).toContain("Não foi possível carregar. Confira a conexão e tente de novo.");
    down = false;
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Tentar de novo" })));
    await settle(8);
    expect(region("Computador da Acme")).toBeTruthy();
    expect(body()).toContain("Onde os agentes trabalham: um computador só deste workspace, sempre ligado.");
  });

  test("an agent on it: Trabalha no Computador da Acme, with no chevron and no picker in its settings", async () => {
    await computers(`/org/${ORG_ID}/agents/${ADA_ID}`, { setup: { state: "preparing" } });
    expect(document.querySelector(".agp-workcard")?.textContent).toContain("Computador da Acme");
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
    cleanup();
    await computers(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=computer`, { setup: { state: "preparing" } });
    expect(document.querySelector(".agp-pc")?.textContent).toContain("Computador da Acme");
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
  });
});

describe("Configurações → Computadores on self-host", () => {
  test("this server's computer first, then the other computers and how to connect one, then each agent's", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`, { host: true });
    expect(body()).toContain(
      "Onde os agentes trabalham: o computador deste servidor e qualquer outro computador que você conectar.",
    );
    const order = [...document.querySelectorAll(".settings__body section[aria-labelledby]")].map((el) =>
      el.getAttribute("aria-labelledby"),
    );
    expect(order.slice(0, 4)).toEqual([
      "sec-host-computer",
      "sec-machines",
      "sec-machines-connect",
      "sec-agent-computers",
    ]);
    const host = region("Computador deste servidor") as HTMLElement;
    expect(host.textContent).toContain("Onde o agentes.chat está instalado, um usuário por agente.");
    expect(host.textContent).toContain("Online");
    // It's this server's: not among the other computers. Their card is its title and ⓘ, and its empty state the
    // title alone.
    const others = region("Outros computadores") as HTMLElement;
    expect(hintOf("Outros computadores", others).text).toBe(
      "Conectados com um código, como um Mac mini em casa ou outro servidor. O que cada um libera se ajusta nele mesmo.",
    );
    expect(shownText(others)).toBe("Outros computadoresNenhum outro computador ainda");
    expect((region("Qual computador cada agente usa") as HTMLElement).textContent).not.toContain("Um por agente");
    expect(body()).not.toMatch(/na nuvem|computador na nuvem|in the cloud/i);
    // What it all means (pausing, folders, the other ways to connect) is one help page, linked once at the end.
    const how = screen().getByRole("link", { name: "Como os computadores funcionam" });
    const url = new URL(how.getAttribute("href") ?? "");
    expect(url.origin + url.pathname).toBe("https://app.agentes.chat/help/computers");
    expect(url.searchParams.get("lang")).toBe("pt-BR");
    expect(how.className).toBe("ac-link ac-link--muted");
    expect(how.getAttribute("rel")).toBe("noopener noreferrer");
    expect([...document.querySelectorAll(".settings__body a")].at(-1)).toBe(how);
  });

  test("with no computer of the server's own, admins read how to make it one, only while sign-up is closed", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`);
    const missing = region("Computador deste servidor") as HTMLElement;
    // The guide's steps: the installer takes no option for it yet (its setup refuses unknown ones).
    expect(missing.textContent).toContain(
      "Este servidor também pode ser o computador dos agentes: os passos estão em “This server as the agents' computer”, no SELF_HOSTING.md.",
    );
    expect(missing.querySelector("code")?.textContent).toBe("SELF_HOSTING.md");
    expect(missing.textContent).not.toContain("--computer");
    cleanup();
    // Open sign-up: the server refuses a computer of its own, so nothing to suggest.
    await computers(`/org/${ORG_ID}/settings/computers`, { signupOpen: true });
    expect(region("Computador deste servidor")).toBeNull();
    cleanup();
    await computers(`/org/${ORG_ID}/settings/computers`, { role: "member" });
    expect(region("Computador deste servidor")).toBeNull();
  });

  test("Daytona's sandboxes only on a server that has them; without them an agent with no computer has none", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`, { daytona: true });
    expect(region("Sandboxes da Daytona")).toBeTruthy();
    expect((region("Qual computador cada agente usa") as HTMLElement).textContent).toContain("Sandbox da Daytona");
    cleanup();

    await computers(`/org/${ORG_ID}/settings/computers`);
    expect(region("Sandboxes da Daytona")).toBeNull();
    const rows = (region("Qual computador cada agente usa") as HTMLElement).textContent ?? "";
    expect(rows).toContain("Nenhum computador");
    expect(rows).not.toMatch(/Nuvem|Daytona/);
    cleanup();

    await computers(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Nenhum computador");
    expect(work.textContent).not.toMatch(/nuvem/i);
  });

  test("a computer's page: Open beside each agent opens its computer in place", async () => {
    const { api, machines } = await computers(`/org/${ORG_ID}/settings/computers`);
    const m = machines.pair({ name: "Mac mini", os: "darwin" });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    cleanup();
    await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(10);
    expect(screen().queryByRole("link", { name: /Tela ao vivo|Ver a tela/ })).toBeNull();
    const open = screen().getByRole("button", { name: "Abrir: Computador da Ada" });
    open.click();
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
  });
});
