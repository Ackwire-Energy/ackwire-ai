import { afterEach, describe, expect, test } from "bun:test";
import type { AiAccounts, AiComputer } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
const base = {
  kind: "claude_code" as const,
  plan: null,
  status: "active" as const,
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usage: null,
  provider: null,
  keyHint: null,
  machineId: "machine_1",
  computer: "MacBook",
};
const WORK: AiAccounts["accounts"][number] = {
  ...base,
  id: "acct_work",
  label: "Trabalho",
  email: "walt@acme.com",
  plan: "team",
  usedBy: ["Ada"],
  usage: {
    windows: [{ kind: "five_hour", usedPercent: 84, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe",
    at: new Date().toISOString(),
  },
};
const MINIMAX: AiAccounts["accounts"][number] = {
  ...base,
  id: "acct_mm",
  label: "MiniMax",
  email: null,
  usedBy: [],
  provider: "minimax",
  keyHint: "MnOp",
};

async function page(accounts: AiAccounts["accounts"], role: "owner" | "member" = "owner") {
  const state = seedState();
  if (state.me?.organizations[0]) state.me.organizations[0].role = role;
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers: [MAC] });
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
  await settle(6);
  const rows = () => [...document.querySelectorAll(".ai-accounts__row")] as HTMLElement[];
  return { state, api, rows };
}

describe("Contas de IA", () => {
  test("never blank: with no plan yet, one way to connect one, the same picker as everywhere", async () => {
    await page([]);
    const plans = screen().getByRole("region", { name: "Seus planos" });
    // Its title and ⓘ (what a plan is for and where it stays), Connect, the empty line: nothing else to read.
    expect(hintOf("Seus planos", plans).text).toBe(
      "Cada plano fica no computador onde foi conectado, e quem administra esse computador pode acessá-lo. O agentes.chat guarda só o nome, o email e o uso.",
    );
    expect(shownText(plans)).toBe("Seus planosConectar uma IANenhum plano ainda.");
    // Its action in its head, the way Provider keys has Add key: the same kind of button in the same place.
    const connect = within(plans).getByRole("button", { name: "Conectar uma IA" });
    const add = within(screen().getByRole("region", { name: "Chaves de provedor" })).getByRole("button", {
      name: "Adicionar chave",
    });
    expect(connect.parentElement?.querySelector("h2")?.textContent).toBe("Seus planos");
    expect(add.parentElement?.querySelector("h2")?.textContent).toBe("Chaves de provedor");
    expect(connect.className).toBe(add.className);
    await act(async () => fireEvent.click(connect));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect(within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" })).toBeTruthy();
  });

  test("a member sees their own plans with their meters, never the workspace's keys; an admin sees both", async () => {
    const member = await page([WORK, MINIMAX], "member");
    // Looking at the plans asks the computers for fresh usage.
    expect(member.state.calls.some((c) => c.method === "machines.refreshAccountUsage")).toBe(true);
    const [work, mm] = member.rows();
    expect(work?.textContent).toContain("Trabalho");
    expect(work?.textContent).toContain("walt@acme.com · Ada pensa com ela");
    expect(work?.querySelector(".ac-planmeter")).not.toBeNull();
    expect(work?.textContent).toContain("Quase no limite");
    // A coding plan's key: its last 4 and what its maker shares.
    expect(mm?.textContent).toContain("chave …MnOp · Nenhum agente ainda");
    expect(mm?.textContent).toContain("MiniMax não mostra o uso por aqui.");
    expect(mm?.querySelector('[data-mark="minimax"]')).not.toBeNull();
    expect(within(mm as HTMLElement).getByRole("button", { name: "Trocar a chave" })).toBeTruthy();
    // Where the accounts stay is the title's ⓘ: no line under the list.
    expect(shownText(screen().getByRole("region", { name: "Seus planos" }))).not.toMatch(/As contas ficam|guarda só/);
    expect(screen().queryByRole("region", { name: "Chaves de provedor" })).toBeNull();
    cleanup();
    await page([WORK]);
    expect(screen().getByRole("region", { name: "Seus planos" })).toBeTruthy();
    expect(screen().getByRole("region", { name: "Chaves de provedor" })).toBeTruthy();
  });

  test("Sign in again: the account's own email goes to Claude's sign-in unseen; another account coming back is said, with Try again only", async () => {
    const out = { ...WORK, status: "signed_out" as const };
    const free = { ...WORK, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com", usedBy: [], usage: null };
    const { state, api, rows } = await page([out, free]);
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "failed",
      signedInAs: "walt@gmail.com",
      duplicate: { label: "Pessoal", account: free },
    });
    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Entrar de novo" }));
    const dialog = screen().getByRole("dialog", { name: "Trabalho" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(dialog).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_work", email: "walt@acme.com" },
    ]);
    expect(shownText(dialog)).toContain(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    // No agent here to think with the one that came back: nothing to use it for.
    expect(within(dialog).queryByRole("button", { name: /^Usar / })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("disconnecting names the agent that thinks with it; renaming saves the new name", async () => {
    const { state, rows } = await page([WORK, MINIMAX]);
    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Desconectar" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar Trabalho?" });
    expect(confirm.textContent).toContain(
      "Ada deixa de pensar com ela. O MacBook sai da conta e apaga o que guardava.",
    );
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.removeAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_work",
    ]);
    expect(document.body.textContent).toContain("Trabalho desconectada.");
    expect(rows()).toHaveLength(1);

    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Renomear" }));
    const rename = screen().getByRole("dialog", { name: "Renomear MiniMax" });
    await act(async () =>
      fireEvent.change(within(rename).getByLabelText("Nome"), { target: { value: "MiniMax do Walt" } }),
    );
    await click(within(rename).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.renameAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_mm",
      "MiniMax do Walt",
    ]);
  });
});

describe("Contas de IA: a plan with a login per agent", () => {
  const usage = (percent: number, at: string) => ({
    windows: [{ kind: "five_hour" as const, usedPercent: percent, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe" as const,
    at,
  });
  /** One GLM key signed in for Ada, Theo and Lia: three logins, one account. */
  type Row = AiAccounts["accounts"][number];
  const glm = (id: string, agent: string, over: Partial<Row> = {}): Row => ({
    ...MINIMAX,
    id,
    label: "GLM Coding",
    provider: "zai",
    keyHint: "4f2a",
    usedBy: [agent],
    ...over,
  });
  const LOGINS = [
    glm("acct_ada", "Ada", { usage: usage(40, "2026-10-27T10:00:00.000Z") }),
    glm("acct_theo", "Theo", { usage: usage(62, "2026-10-27T11:00:00.000Z") }),
    glm("acct_lia", "Lia"),
  ];

  test("one row for the account: every agent on it, one meter from the newest usage", async () => {
    const { rows } = await page(LOGINS);
    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(row?.textContent).toContain("chave …4f2a · Ada, Theo e Lia pensam com ela");
    expect(row?.querySelectorAll(".ac-planmeter")).toHaveLength(1);
    expect(row?.textContent).toContain("62%");
    // Its name's capitals start at its mark's top; its actions stay in the row's middle, evenly spaced.
    expect(row?.querySelector(".list-col > :first-child")?.classList.contains("ac-captop")).toBe(true);
    expect(row?.querySelector(":scope > .ac-acts")).not.toBeNull();
  });

  test("one login signed out: whose, said under the facts", async () => {
    const [ada, theo, lia] = LOGINS as [Row, Row, Row];
    const { rows } = await page([ada, { ...theo, status: "signed_out" }, lia]);
    expect(rows()[0]?.textContent).toContain("Theo ficou sem login.");
  });

  test("Disconnect takes every login of the account, and the dialog names every agent", async () => {
    const { state, rows } = await page(LOGINS);
    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Desconectar" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar GLM Coding?" });
    expect(confirm.textContent).toContain(
      "Ada, Theo e Lia deixam de pensar com ela. O MacBook sai da conta e apaga o que guardava.",
    );
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual([
      "acct_ada",
      "acct_theo",
      "acct_lia",
    ]);
  });

  test("two accounts with the same name stay two rows: a name is anyone's to repeat", async () => {
    const other = glm("acct_bo", "Bo", { keyHint: "9z9z" });
    const { state, rows } = await page([...LOGINS, other]);
    expect(rows()).toHaveLength(2);
    expect(rows()[1]?.textContent).toContain("chave …9z9z · Bo pensa com ela");
    await click(within(rows()[1] as HTMLElement).getByRole("button", { name: "Desconectar" }));
    await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual(["acct_bo"]);
  });

  test("Replace the key: the new key goes to every login of the account, sealed to each", async () => {
    const { state, api, rows } = await page(LOGINS);
    const machines = fakeMachinesOf.get(api);
    for (const [n, l] of LOGINS.entries()) machines?.endLogin(`login_${n + 1}`, { state: "done", account: l });
    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Trocar a chave" }));
    const dialog = screen().getByRole("dialog", { name: "GLM Coding" });
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Chave do GLM Coding"), {
        target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
      }),
    );
    await click(within(dialog).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(12);
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_ada", provider: "zai" },
      { accountId: "acct_theo", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
    ]);
    expect(new Set(machines?.logins().map((l) => JSON.stringify(l.box))).size).toBe(3);
    // Each took it: the dialog closes.
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Replace the key, one login failing: Try again sends the key only to that login", async () => {
    const { state, api, rows } = await page(LOGINS);
    const machines = fakeMachinesOf.get(api);
    const [ada, theo, lia] = LOGINS as [Row, Row, Row];
    machines?.endLogin("login_1", { state: "done", account: ada });
    machines?.endLogin("login_2", { state: "done", account: theo });
    machines?.endLogin("login_3", { state: "failed" });
    machines?.endLogin("login_4", { state: "done", account: lia });
    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Trocar a chave" }));
    const dialog = screen().getByRole("dialog", { name: "GLM Coding" });
    const send = async () => {
      await act(async () =>
        fireEvent.change(within(dialog).getByLabelText("Chave do GLM Coding"), {
          target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
        }),
      );
      await click(within(dialog).getByRole("button", { name: "Enviar ao MacBook" }));
      await settle(12);
    };
    await send();
    await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
    await send();
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_ada", provider: "zai" },
      { accountId: "acct_theo", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
    ]);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("an account for all of Walter's agents there: Use for Atlas too gives it, no sign-in; Disconnect says to revoke the token on Claude", async () => {
    const state = seedState();
    for (const a of state.agents) a.ownerUserId = "u-walter";
    state.aiStatus = { any: false, agents: [{ agentId: ATLAS_ID, state: "no_ai", reason: "no_key" }] };
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    machines?.pair({
      id: "machine_1",
      name: "MacBook",
      mode: "system",
      agents: state.agents.slice(0, 2).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
    });
    const all = {
      ...base,
      id: "acct_all",
      label: "Claude",
      email: null,
      usedBy: ["Ada"],
      usedByIds: [ADA_ID],
      shared: true,
    };
    machines?.setAiAccounts({ accounts: [all], computers: [MAC] });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(6);
    const row = document.querySelector(".ai-accounts__row") as HTMLElement;
    expect(row.textContent).toContain("Ada pensa com ela");
    await click(within(row).getByRole("button", { name: "Usar também para o Atlas" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ATLAS_ID, { brain: "claude_code", account: "acct_all" }],
    ]);
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
    await click(within(row).getByRole("button", { name: "Desconectar" }));
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("Para encerrar também no Claude, revogue nas configurações do Claude.");
  });
});
