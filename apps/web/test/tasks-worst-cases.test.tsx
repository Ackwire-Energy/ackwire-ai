import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Issue, IssueWork, Member } from "@agenteschat/client";
import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { cleanup, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

/**
 * Tarefas with what breaks a card, a row and the details' strip (break-ui): an unbroken address in a title, twelve
 * criteria, a PR and a GitHub link at once, 1284 messages with twelve mentions, Japanese with emoji, a long name, a
 * long label, a bare "Ok", every fact at once; in the strip a long name and column, seven people, three PRs, twelve
 * labels, a long GitHub link, and German. CI's geometry check lays out every screen these tests reach at 1280, 390
 * and 320.
 */
const URL_TITLE =
  "Atualizar https://docs.example.com/integracoes/whatsapp-business/webhooks/configuracao-avancada antes da revisão";
const LONG_PERSON = "Aleksandra Wiśniewska-Kowalczyk";
const LONG_ASSIGNEE = "Christopher Alexander Montgomery III";
const LONG_LABEL = "infraestrutura-e-plataforma";
const LONG_GITHUB = "https://github.com/example-org/a-very-long-repository-name/pull/10942";

const person = (userId: string, name: string): Member => ({
  userId,
  name,
  email: `${userId}@example.com`,
  image: null,
  role: "member",
  joinedAt: new Date(Date.now() - 86_400_000).toISOString(),
  handle: userId,
  timezone: "America/Sao_Paulo",
});
const PEOPLE = [
  person("u-ale", LONG_PERSON),
  person("u-chris", LONG_ASSIGNEE),
  person("u-bea", "Bea"),
  person("u-caio", "Caio"),
  person("u-dora", "Dora"),
  person("u-enzo", "Enzo"),
  person("u-fe", "Fê"),
];
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const work = (agentId: string, state: IssueWork["state"]): IssueWork => ({
  agentId,
  runId: "run-w",
  state,
  since: new Date(Date.now() - 3 * 7 * 86_400_000).toISOString(),
  steps: [{ tool: "update_issue", detail: "#7", at: new Date().toISOString() }],
});
const criteria = (done: number, total: number) =>
  Array.from({ length: total }, (_, k) => ({ id: `c${k}`, text: `Critério ${k + 1}`, done: k < done }));
const talk = (count: number) => ({
  channelId: `task-${count}`,
  rootId: `root-${count}`,
  count,
  lastAt: new Date().toISOString(),
  participants: [],
  working: false,
});

/** The worst tasks, added to the fake's own, as the server sends them. */
function worst(base: Issue): Issue[] {
  const task = (over: Partial<Issue> & Pick<Issue, "number" | "title" | "status">): Issue => ({
    ...base,
    id: `w-${over.number}`,
    columnId: `col-${over.status}`,
    boardRank: -over.number,
    labels: [],
    priority: "normal",
    dueDate: null,
    criteria: [],
    pullRequests: [],
    githubUrl: null,
    work: null,
    conversation: null,
    assignee: null,
    ...over,
  });
  return [
    task({
      number: 12873,
      title: URL_TITLE,
      status: "in_review",
      labels: [LONG_LABEL, "agendamento"],
      priority: "high",
      dueDate: day(1),
      criteria: criteria(3, 12),
      pullRequests: [{ number: 10942, url: "https://github.com/agentes-chat/app/pull/10942", openedBy: null }],
      githubUrl: "https://github.com/agentes-chat/agentes-chat/issues/4521",
      assignee: { type: "agent", id: ATLAS_ID },
      work: work(ATLAS_ID, "waiting_approval"),
      conversation: talk(1284),
    }),
    task({
      number: 7,
      title: "Ok",
      status: "in_review",
      assignee: { type: "agent", id: ADA_ID },
      work: work(ADA_ID, "running"),
    }),
    task({
      number: 9931,
      title: "修正: 予約確認のメッセージが二重に送信される問題 🔁📅",
      status: "in_review",
      labels: ["国際化"],
      priority: "low",
      dueDate: day(-4),
      assignee: { type: "agent", id: ADA_ID },
      work: work(ADA_ID, "stalled"),
      conversation: talk(9),
    }),
    task({
      number: 455,
      title: "Revisar contrato",
      status: "in_review",
      dueDate: day(40),
      criteria: criteria(2, 2),
      assignee: { type: "person", id: "u-ale" },
      conversation: talk(2),
    }),
  ];
}

const go = async (layout: "board" | "list" = "board", path = "issues") => {
  const state = seedState();
  state.members.push(...PEOPLE);
  state.issuesView = { ...structuredClone(ISSUES_VIEW_DEFAULT), layout };
  state.unreadTasks = [{ issueId: "w-12873", unread: 3, mentions: 12 }];
  const api = createFakeApi(state);
  const list = api.issues.list;
  api.issues.list = async (orgId, filters) => {
    const own = await list(orgId, filters);
    return [...own, ...worst(own[0] as Issue)];
  };
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return { ...r, api, state };
};
const cardOf = (n: number) => document.querySelector<HTMLElement>(`[data-card="${n}"]`) as HTMLElement;
const facts = (el: HTMLElement) =>
  [...el.querySelectorAll(".issue-card__facts > .ac-factline__fact")].map((f) => f.textContent);

describe("Tarefas at their worst", () => {
  test("the board: every fact at once, a URL title whole, Japanese, a bare Ok, a long name under its face", async () => {
    await go();
    const all = cardOf(12873);
    expect(all.querySelector(".issue-card__title")?.textContent).toBe(URL_TITLE);
    expect(facts(all)).toEqual([
      "#12873",
      LONG_LABEL,
      "+1",
      "Alta",
      "amanhã",
      "3/12",
      "PR #10942",
      "agentes-chat#4521",
      "128412",
    ]);
    expect(all.querySelector(".issue-card__state")?.textContent).toBe("Pede aprovação");
    expect(facts(cardOf(7))).toEqual(["#7"]);
    expect(cardOf(7).querySelector(".issue-card__state")?.textContent).toBe("Trabalhando");
    expect(cardOf(9931).querySelector(".issue-card__state")?.textContent).toBe("Parado há 21 dias");
    expect(cardOf(455).querySelector(".issue-card__who .ac-who > b")?.textContent).toBe(LONG_PERSON);
  });

  test("the list: the same parts in one row, stacked on a phone", async () => {
    await go("list");
    const row = cardOf(12873);
    expect(row.classList.contains("issue-list__row")).toBe(true);
    expect(row.querySelector(".issue-list__title")?.textContent).toBe(URL_TITLE);
    expect(facts(row)[0]).toBe("#12873");
  });

  test("the details' strip: a long name and column, seven people, three PRs, twelve labels, a long GitHub link, German", async () => {
    const { api } = await go("board", "issues");
    const task = await api.issues.get(ORG_ID, 131);
    await api.issues.addColumn(ORG_ID, { name: "Aguardando aprovação do jurídico", stage: "todo" });
    const column = (await api.issues.columns(ORG_ID)).find((c) => c.name === "Aguardando aprovação do jurídico");
    await api.issues.update(ORG_ID, task.id, {
      assignee: { type: "person", id: "u-chris" },
      columnId: column?.id,
      githubUrl: LONG_GITHUB,
      labels: [LONG_LABEL, ...Array.from({ length: 11 }, (_, k) => `etiqueta-${k + 1}`)],
    });
    const get = api.issues.get;
    api.issues.get = async (orgId, number) => {
      const i = await get(orgId, number);
      return number === 131
        ? {
            ...i,
            audience: { mode: "people", userIds: PEOPLE.map((p) => p.userId), channelId: null },
            pullRequests: [101, 10942, 2].map((n) => ({
              number: n,
              url: `https://github.com/agentes-chat/app/pull/${n}`,
              openedBy: { type: "agent" as const, id: ADA_ID },
            })),
          }
        : i;
    };
    cleanup();
    const { services } = await renderApp(`/org/${ORG_ID}/issues/131`, { api });
    await settle(8);
    const strip = screen().getByRole("group", { name: "Detalhes da tarefa" });
    expect(within(strip).getByRole("combobox", { name: "Responsável" }).textContent).toContain(LONG_ASSIGNEE);
    expect(within(strip).getByRole("combobox", { name: "Coluna" }).textContent).toBe(
      "Aguardando aprovação do jurídico",
    );
    expect(within(strip).getByRole("link", { name: "a-very-long-repository-name#10942" })).toBeTruthy();
    expect(strip.querySelectorAll(".issue-label")).toHaveLength(12);
    expect(strip.querySelectorAll(".issue-link")).toHaveLength(3);
    await showIn(services, "de");
    expect(screen().getByRole("group", { name: "Details der Aufgabe" })).toBeTruthy();
  });
});
