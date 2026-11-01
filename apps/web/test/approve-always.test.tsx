import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Approval, ApprovalRule } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const EXECUTOR = "COMPOSIO_MULTI_EXECUTE_TOOL";
const TITLE = "Composio: GITHUB_CREATE_AN_ISSUE_COMMENT";
const HINT = "Aprova este e os próximos iguais da Ada: Criar comentário da issue (Github), com qualquer valor.";

/** The seed's first request (Ada's card in #eng) as one through Composio's executor, which offers "Aprovar sempre". */
function withComposio(state = seedState()) {
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  Object.assign(first, {
    tool: `composio_${EXECUTOR}`,
    scope: "custom:conn-composio:write",
    title: TITLE,
    detail: `${EXECUTOR} · tools=[{"tool_slug":"GITHUB_CREATE_AN_ISSUE_COMMENT"}]`,
    connector: "custom:conn-composio",
    approveAlways: { tool: EXECUTOR, actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] },
  });
  return state;
}

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** In the conversation, "Aprovar sempre" and what it covers live behind the request card's "Ver detalhes". */
const seeDetails = (card: HTMLElement) => click(within(card).getByRole("button", { name: "Ver detalhes" }));
const approveCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "approvals.approve").map((c) => c.args);

describe("Aprovar sempre on a request", () => {
  test("in the conversation: the button and what it covers; it approves for good and says where to undo", async () => {
    const state = withComposio();
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.textContent).not.toContain(HINT);
    await seeDetails(card);
    expect(card.textContent).toContain(HINT);
    expect(card.querySelector(".ap-always")?.getAttribute("title")).toBe("GITHUB_CREATE_AN_ISSUE_COMMENT");
    await click(within(card).getByRole("button", { name: "Aprovar sempre" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
    expect(screen().getByRole("group", { name: "Aprovação concluída" })).toBeTruthy();
    const toast = screen().getByRole("status");
    expect(toast.textContent).toContain("Aprovado. Ada não pede mais para isso.");
    expect(toast.textContent).toContain("Para desfazer, vá em Ferramentas e acesso, na página da Ada.");
    await click(within(toast).getByRole("button", { name: "Abrir" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    expect(router.state.location.search).toMatchObject({ tab: "access" });
  });

  test("a request that doesn't offer it shows no button, and approving it once stays as it was", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    await seeDetails(card);
    expect(within(card).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    expect(card.querySelector(".ap-always")).toBeNull();
    await click(within(card).getByRole("button", { name: "Aprovar merge" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined]]);
  });

  test("on Aprovações: on the card and in its details, never on a high-risk one", async () => {
    const state = withComposio();
    const deploy = state.approvals[1];
    if (deploy) deploy.approveAlways = { tool: "run_workflow", actions: [] };
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("article", { name: TITLE });
    expect(card.textContent).toContain(HINT);
    expect(within(card).getByRole("button", { name: "Aprovar sempre" })).toBeTruthy();
    const risky = screen().getByRole("article", { name: "Run deploy workflow" });
    expect(within(risky).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    await click(within(card).getByRole("button", { name: "Detalhes" }));
    const dialog = screen().getByRole("dialog", { name: TITLE });
    expect(dialog.textContent).toContain(HINT);
    await click(within(dialog).getByRole("button", { name: "Aprovar sempre" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
  });
});

describe("Ferramentas e acesso: Aprovado sempre", () => {
  const rules = (): ApprovalRule[] => [
    {
      id: "rule-1",
      connectionId: "conn-composio",
      server: "Composio",
      tool: EXECUTOR,
      toolLabel: "Executar ferramentas",
      action: "GITHUB_CREATE_AN_ISSUE_COMMENT",
      createdByUserId: "u-joao",
      createdAt: new Date().toISOString(),
    },
    {
      id: "rule-2",
      connectionId: "conn-composio",
      server: "Composio",
      tool: "close_ticket",
      toolLabel: "Fechar chamado",
      action: "",
      createdByUserId: null,
      createdAt: new Date().toISOString(),
    },
  ];
  const page = async (state = seedState()) => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    return state;
  };
  const card = () => screen().queryByRole("region", { name: "Aprovado sempre" });

  test("lists what Ada runs without asking, by whom and when; × makes her ask again, at once", async () => {
    const state = seedState();
    state.approvalRules = { [ADA_ID]: rules() };
    await page(state);
    const list = card();
    if (!list) throw new Error("no card");
    expect(list.textContent).toContain("Roda sem pedir, com qualquer valor.");
    const rows = [...list.querySelectorAll("li")].map((li) => li.querySelector(".level-row__text")?.textContent);
    expect(rows).toEqual([
      "ComposioCriar comentário da issue (Github)Aprovado por João · agora",
      "ComposioFechar chamadoAprovado · agora",
    ]);
    expect(within(list).getByText("Criar comentário da issue (Github)").getAttribute("title")).toBe(
      "GITHUB_CREATE_AN_ISSUE_COMMENT",
    );
    await click(within(list).getByRole("button", { name: "Voltar a pedir: Fechar chamado" }));
    expect(state.calls.find((c) => c.method === "approvals.removeRule")?.args).toEqual([ORG_ID, ADA_ID, "rule-2"]);
    expect(document.body.textContent).toContain("Ada volta a pedir para isso.");
    expect([...(card()?.querySelectorAll("li") ?? [])]).toHaveLength(1);
    // Nothing waits in the save bar: it saved on its own.
    expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
  });

  test("a member reads it without ×; the agent's owner may remove; nothing approved for good, no card", async () => {
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    member.approvalRules = { [ADA_ID]: rules() };
    await page(member);
    expect(card()).toBeTruthy();
    expect(within(card() as HTMLElement).queryAllByRole("button")).toEqual([]);
    cleanup();

    const owner = seedState();
    if (owner.me?.organizations[0]) owner.me.organizations[0].role = "member";
    const ada = owner.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    owner.approvalRules = { [ADA_ID]: rules() };
    await page(owner);
    expect(
      within(card() as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Voltar a pedir: Criar comentário da issue (Github)", "Voltar a pedir: Fechar chamado"]);
    cleanup();

    await page();
    expect(document.body.textContent).toContain("Merge, deploy e rollback sempre pedem aprovação no chat.");
    expect(card()).toBeNull();
  });
});

describe("git requests", () => {
  const branches = ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "old-7"];
  /** The seed's first request (Ada's card in #eng) as one of the git tools. */
  const withGit = (over: Partial<Approval>, state = seedState()) => {
    const first = state.approvals[0];
    if (!first) throw new Error("no approval");
    Object.assign(first, { scope: "github:git.write", connector: "github", detail: "", ...over });
    return state;
  };
  const push = {
    tool: "request_branch_push",
    title: "Enviar para ana/fix em acme/app (24 h, sem force push)",
    params: { repo: "acme/app", branch: "ana/fix" },
    approveAlways: { tool: "request_branch_push", actions: ["acme/app:ana/fix"] },
  };
  const remove = {
    tool: "delete_branches",
    title: "Apagar 7 branches em acme/app",
    detail: branches.join("\n"),
    params: { repo: "acme/app", branches },
    approveAlways: null,
  };

  test("a push to someone's branch: one tap, and Aprovar sempre for that branch alone", async () => {
    const state = withGit(push);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.textContent).toContain("Enviar para ana/fix em acme/app (24 h, sem force push)");
    await seeDetails(card);
    expect(card.textContent).toContain("Aprova este e os próximos iguais da Ada: enviar para ana/fix em acme/app.");
    expect(card.textContent).not.toContain("com qualquer valor");
    await click(within(card).getByRole("button", { name: "Aprovar sempre" }));
    expect(approveCalls(state)).toEqual([[ORG_ID, "ap-merge", undefined, true]]);
  });

  test("deleting branches: the batch on one card, held to approve, never Aprovar sempre", async () => {
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(withGit(remove)) });
    await settle(4);
    const card = screen().getByRole("article", { name: "Apagar 7 branches em acme/app" });
    expect(card.textContent).toContain("old-1, old-2, old-3");
    expect(within(card).queryByRole("button", { name: "Aprovar sempre" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Aprovar exclusão: segure para confirmar" })).toBeTruthy();
  });

  test("Ferramentas e acesso: a remembered push reads as its branch, and × takes it back", async () => {
    const state = seedState();
    state.approvalRules = {
      [ADA_ID]: [
        {
          id: "rule-git",
          connectionId: "conn-gh",
          server: "GitHub",
          tool: "request_branch_push",
          toolLabel: "request_branch_push",
          action: "acme/app:ana/fix",
          createdByUserId: "u-joao",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    const list = screen().getByRole("region", { name: "Aprovado sempre" });
    expect(list.querySelector(".level-row__text")?.textContent).toBe(
      "GitHubenviar para ana/fix em acme/appAprovado por João · agora",
    );
    expect(within(list).getByText("enviar para ana/fix em acme/app").getAttribute("title")).toBe("acme/app:ana/fix");
    await click(within(list).getByRole("button", { name: "Voltar a pedir: enviar para ana/fix em acme/app" }));
    expect(state.calls.find((c) => c.method === "approvals.removeRule")?.args).toEqual([ORG_ID, ADA_ID, "rule-git"]);
    expect(screen().queryByRole("region", { name: "Aprovado sempre" })).toBeNull();
  });
});
