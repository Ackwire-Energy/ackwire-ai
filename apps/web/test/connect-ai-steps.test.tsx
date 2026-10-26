import { afterEach, describe, expect, test } from "bun:test";
import type { AiComputer, ComputerSetup, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};

const account = (over: Partial<MachineAccount> = {}): MachineAccount => ({
  id: "acct_new",
  kind: "claude_code",
  label: "GLM Coding",
  email: null,
  plan: null,
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: "zai",
  keyHint: "MnOp",
  ...over,
});

/**
 * Contas de IA with the MacBook (Ada on it, Walter's), and "Conectar uma IA" opened. `setup`: the workspace gets
 * its own computer (the Cloud), this far; then there is no MacBook.
 */
async function connect(computers: AiComputer[] = [MAC], setup?: Partial<ComputerSetup>) {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "u-walter";
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (setup) machines?.setSetup(setup);
  else machines?.pair({ id: "machine_1", name: "MacBook", agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }] });
  machines?.setAiAccounts({ accounts: [], computers });
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
  await settle(6);
  await click(screen().getByRole("button", { name: "Conectar uma IA" }));
  const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
  return { state, api, machines, dialog };
}

describe("Conectar uma IA", () => {
  test("a coding plan's key: its own key page, the key sealed to the computer (in no request), then its name and agent", async () => {
    const { state, machines, dialog } = await connect();
    // The plans each computer can take; the first steps say what each is.
    for (const name of ["Claude", "ChatGPT", "GLM Coding", "Kimi Code", "MiniMax", "OpenCode Go"])
      expect(within(dialog).getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    machines?.endLogin("login_1", { state: "done", account: account() });
    await click(within(dialog).getByRole("button", { name: /^GLM Coding/ }));
    const block = within(dialog).getByRole("region", { name: "Conectar GLM Coding" });
    expect(within(block).getByRole("link", { name: "Abrir z.ai" }).getAttribute("href")).toBe(
      "https://z.ai/manage-apikey/apikey-list",
    );
    // Nothing starts on the computer until the key is there; a paste that isn't a key says so.
    expect(machines?.lastLogin()).toBeUndefined();
    const keyBox = within(block).getByLabelText("Chave do GLM Coding");
    await type(keyBox, "short");
    expect(block.textContent).toContain("Isso não parece uma chave do GLM Coding.");
    const KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";
    await type(keyBox, KEY);
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { provider: "zai" },
    ]);
    expect(machines?.lastLogin()?.box).not.toBeNull();
    expect(JSON.stringify(state.calls)).not.toContain("0123456789abcdef");

    // The last step: what people call it, and the agent it thinks for.
    expect(dialog.textContent).toContain("Pronto: GLM Coding está no MacBook.");
    await type(within(dialog).getByLabelText("Como quer chamar esta conta? Os outros veem este nome."), "GLM do Walt");
    await click(within(dialog).getByRole("button", { name: "Concluir" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "machines.renameAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_new",
      "GLM do Walt",
    ]);
    expect(state.calls.find((c) => c.method === "agents.setBrain")?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_new" },
    ]);
    expect(document.body.textContent).toContain("Ada agora pensa com GLM do Walt.");
  });

  test("ChatGPT shows the code to type on its page", async () => {
    const { dialog } = await connect();
    await click(within(dialog).getByRole("button", { name: /^ChatGPT/ }));
    await settle(6);
    const block = within(dialog).getByRole("region", { name: "Adicionar conta do Codex" });
    expect(within(block).getByRole("status", { name: "" }).textContent).toContain("Esperando");
    expect(within(block).getByLabelText("Código para o ChatGPT").textContent).toBe("ABCD-1234");
  });

  test("Claude: the same account twice is refused, and the page says how to add another", async () => {
    const { machines, dialog } = await connect();
    machines?.endLogin("login_1", { state: "failed", duplicate: { label: "Trabalho" } });
    await click(within(dialog).getByRole("button", { name: /^Claude/ }));
    await click(within(dialog).getByRole("button", { name: "Entrar com Claude" }));
    await settle(8);
    expect(dialog.textContent).toContain(
      "Essa conta já está aqui (Trabalho). Para adicionar outra, saia do Claude na página que abriu",
    );
    expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("a choice no computer of the person's can take says why; with none, connecting one comes first", async () => {
    const { dialog } = await connect([{ ...MAC, keys: false, brains: { claude_code: true, codex: false } }]);
    const chatgpt = within(dialog).getByRole("button", { name: /^ChatGPT/ }) as HTMLButtonElement;
    expect(chatgpt.disabled).toBe(true);
    expect(chatgpt.textContent).toContain("Precisa de um computador seu com o Codex");
    const kimi = within(dialog).getByRole("button", { name: /^Kimi Code/ }) as HTMLButtonElement;
    expect(kimi.disabled).toBe(true);
    expect(kimi.textContent).toContain("Atualize o agentes no computador");
    cleanup();
    const none = await connect([{ ...MAC, canAdd: false, mine: false }]);
    expect(none.dialog.textContent).toContain("Conecte um seu primeiro.");
    expect(within(none.dialog).getByRole("link", { name: "Conectar um computador" })).toBeTruthy();
  });

  test("before the server says which edition this is: a wait, never a computer to connect", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [] });
    // The Cloud's answer still on its way: self-host's words would send its people to pair a computer.
    api.machines.computerSetup = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(6);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }));
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect(within(dialog).queryByRole("link", { name: "Conectar um computador" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Conecte um seu|computador conectado/);
  });

  test("on the Cloud, while the workspace's computer is prepared: where plans will sign in and how long, no computer to connect", async () => {
    const { dialog } = await connect([], {
      step: "installing",
      secondsLeft: 330,
      expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
      notifyByEmail: true,
    });
    expect(dialog.textContent).toContain(
      "Os seus planos entram no Computador da Acme, que está sendo preparado. Volte aqui quando ele ficar pronto.",
    );
    expect(dialog.textContent).toContain("Faltam uns 6 min");
    expect(dialog.textContent).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
    expect(within(dialog).queryByRole("link", { name: "Conectar um computador" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Conecte um seu|computador conectado/);
  });

  test("on the Cloud, its computer not answering: said by name, looked after", async () => {
    const workspace: AiComputer = {
      ...MAC,
      machineId: "managed_1",
      name: "Computador da Acme",
      online: false,
      mine: false,
    };
    const { dialog } = await connect([workspace], { state: "ready" });
    const claude = within(dialog).getByRole("button", { name: /^Claude/ }) as HTMLButtonElement;
    expect(claude.disabled).toBe(true);
    expect(claude.textContent).toContain("O Computador da Acme não está respondendo agora. Já estamos cuidando.");
    expect(dialog.textContent).not.toMatch(/Seu computador está desligado|desligado/);
  });
});
