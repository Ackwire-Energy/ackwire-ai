import { afterEach, describe, expect, test } from "bun:test";
import type { AiAccounts, AiComputer } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
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
    // Its title and ⓘ (what a plan is for and where it stays), the empty line, Connect: nothing else to read.
    expect(hintOf("Seus planos", plans).text).toBe(
      "Cada conta pensa por um agente e fica no computador onde foi conectada; quem administra esse computador pode acessá-la. O agentes.chat guarda só o nome, o email e o uso.",
    );
    expect(shownText(plans)).toBe("Seus planosNenhum plano ainda.Conectar uma IA");
    await act(async () => fireEvent.click(within(plans).getByRole("button", { name: "Conectar uma IA" })));
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

  test("disconnecting names the agent that thinks with it; renaming saves the new name", async () => {
    const { state, rows } = await page([WORK, MINIMAX]);
    await click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Desconectar" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar Trabalho?" });
    expect(confirm.textContent).toContain("Ada deixa de pensar com ela e volta para a API.");
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
