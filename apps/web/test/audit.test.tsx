import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AuditRow } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const row = (over: Partial<AuditRow> & Pick<AuditRow, "id">): AuditRow => ({
  at: at(5),
  actor: { type: "agent", id: ADA_ID, name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "create_issue" },
  details: { kind: "internal", behind: "person", input: {} },
  runId: "run-1",
  channelId: GENERAL_ID,
  channel: { id: GENERAL_ID, name: "general", kind: "channel" },
  onBehalfOf: { id: "u-walter", name: "Walter" },
  outcome: "done",
  approval: null,
  ...over,
});

const AUDIT: AuditRow[] = [
  row({
    id: "a5",
    actor: { type: "agent", id: ATLAS_ID, name: "Atlas" },
    target: { type: "tool", id: "railway_deploy" },
    details: {
      kind: "external",
      connector: "Railway",
      title: "Railway: Deploy api",
      behind: "person",
      reason: "The login broke after the last deploy.",
      approvalId: "ap-1",
      input: { service: "api" },
    },
    outcome: "pending",
    approval: { id: "ap-1", status: "pending", decidedBy: null },
  }),
  row({
    id: "a4",
    target: { type: "tool", id: "drive_delete" },
    details: {
      kind: "internal",
      behind: "person",
      reason: "Ada lacks the scope drive:write",
      input: { file: "contratos-2025.pdf", apiKey: "***" },
    },
    outcome: "refused",
  }),
  row({
    id: "a3",
    target: { type: "tool", id: "sentry_list_issues" },
    details: { kind: "read", connector: "Sentry", title: "Sentry: List issues", behind: "person", input: {} },
  }),
  row({ id: "a2", details: { kind: "internal", behind: "routine", routine: { id: "r1", name: "Follow-up" }, input: {} } }),
  row({
    id: "a1",
    at: at(60 * 24),
    actor: { type: "person", id: "u-walter", name: "Walter" },
    action: "routine.created",
    target: { type: "routine", id: "r1" },
    details: { name: "Follow-up" },
    runId: null,
    channelId: null,
    channel: null,
    onBehalfOf: null,
    outcome: null,
  }),
];

const go = async (state = seedState({ audit: AUDIT })) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/settings/audit`, { api });
  await settle(6);
  return { api, r, state };
};
const section = () => screen().getByRole("region", { name: "Auditoria" });
const titles = () => [...section().querySelectorAll(".audit-row__title")].map((e) => e.textContent);

describe("Configurações → Auditoria", () => {
  test("one list by day: who did what, asked by whom, where, and how it ended", async () => {
    await go();
    expect(titles()).toEqual([
      "Atlas usou o Railway",
      "Ada usou a ferramenta drive delete",
      "Ada consultou o Sentry",
      "Ada criou uma tarefa",
      "Walter criou uma rotina",
    ]);
    const first = section().querySelector(".audit-row") as HTMLElement;
    expect(first.textContent).toContain("Railway: Deploy api · pedido por Walter · #general");
    expect(first.textContent).toContain("Esperando aprovação");
    expect(section().textContent).toContain("rotina Follow-up");
    expect([...section().querySelectorAll(".audit__day")].map((d) => d.textContent)).toEqual(["Hoje", "Ontem"]);
  });

  test("the shortcuts: what went wrong, what waits, people's changes", async () => {
    await go();
    await click(within(section()).getByRole("radio", { name: "Recusadas e falhas" }));
    await settle(4);
    expect(titles()).toEqual(["Ada usou a ferramenta drive delete"]);
    await click(within(section()).getByRole("radio", { name: "Esperando" }));
    await settle(4);
    expect(titles()).toEqual(["Atlas usou o Railway"]);
    await click(within(section()).getByRole("radio", { name: "Mudanças de pessoas" }));
    await settle(4);
    expect(titles()).toEqual(["Walter criou uma rotina"]);
  });

  test("a row opens the thread's panel: the reason, what was sent (secrets hidden), the conversation", async () => {
    await go();
    const refused = [...section().querySelectorAll<HTMLElement>(".audit-row")][1] as HTMLElement;
    await click(refused);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.classList.contains("thread-panel")).toBe(true);
    expect(panel.textContent).toContain("Por que foi recusado: Ada lacks the scope drive:write");
    expect(panel.textContent).toContain("contratos-2025.pdf");
    expect(panel.textContent).toContain("escondido");
    expect(panel.textContent).not.toContain("***");
    expect(within(panel).getByRole("link", { name: "Abrir conversa" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${GENERAL_ID}`,
    );
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen().queryByRole("complementary", { name: "Detalhe da auditoria" })).toBeNull();
  });

  test("a waiting call links to its request", async () => {
    await go();
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.textContent).toContain("Ainda ninguém respondeu");
    expect(within(panel).getByRole("link", { name: "Ver o pedido" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/approvals?open=ap-1`,
    );
  });

  test("members don't see it", async () => {
    const state = seedState({ audit: AUDIT });
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(screen().queryByRole("region", { name: "Auditoria" })).toBeNull();
  });
});
