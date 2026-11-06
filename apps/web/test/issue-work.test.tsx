import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup } from "@testing-library/react";
import { PrivateTaskBlock } from "@/components/BackgroundWork";
import { IssueTakenLine, IssueWorkCard } from "@/components/IssueWork";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

describe("asking an agent to implement an issue", () => {
  test("the DM thread's root is a card: who asked, the number, the title, the live status and 'Ver issue'", async () => {
    const api = createFakeApi(seedState());
    const issue = await api.issues.create(ORG_ID, { title: "Login quebra no Safari" });
    await renderPage(
      <IssueWorkCard
        work={{ issueId: issue.id, number: issue.number, title: "Título antigo", agentId: ADA_ID }}
        authorId={null}
      />,
      { api, org: true },
    );
    await settle(3);
    const card = document.querySelector(".iw-card") as HTMLElement;
    expect(card.textContent).toContain("Você pediu a tarefa");
    expect(card.textContent).toContain(`#${issue.number}`);
    // The issue's current title and status, not the copy in the message.
    expect(card.textContent).toContain("Login quebra no Safari");
    expect(card.textContent).toContain("A fazer");
    const open = [...card.querySelectorAll("a")].find((a) => a.textContent?.includes("Ver tarefa"));
    expect(open?.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/${issue.number}`);
    // Nothing internal: no ids, no instructions.
    expect(card.textContent).not.toContain(issue.id);
    expect(card.textContent).not.toContain("comment_issue");
  });

  test("where the issue came from: one quiet line with the agent and the link", async () => {
    const message: Message = {
      id: "m-taken",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Took issue #24: Checkout quebra",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        issueTaken: { issueId: "iss_1", number: 24, title: "Checkout quebra", agentId: ADA_ID },
        bodyCode: "issue_taken",
        bodyParams: { number: 24 },
      },
      createdAt: new Date().toISOString(),
    };
    await renderPage(<IssueTakenLine message={message} />, { api: createFakeApi(seedState()), org: true });
    await settle(2);
    const line = document.querySelector(".iw-line") as HTMLElement;
    expect(line.textContent).toMatch(/Ada pegou a tarefa #24 · Checkout quebra/);
    expect(line.querySelector("a")?.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/24`);
    expect(line.textContent).not.toContain("iss_1");
  });
});

describe("a task tied to a private conversation", () => {
  const made = async (createdBy: { type: "agent" | "person"; id: string }) => {
    const api = createFakeApi(seedState());
    const issue = await api.issues.create(ORG_ID, { title: "Fechar a folha" });
    const shared: string[] = [];
    api.issues.share = async (_orgId, id) => {
      shared.push(id);
      return issue;
    };
    await renderPage(<PrivateTaskBlock issue={{ ...issue, channelId: "a-dm-not-in-the-list", createdBy }} />, {
      api,
      org: true,
    });
    await settle(3);
    return shared;
  };

  test("an agent's says who sees it, and anyone there can show it to everyone", async () => {
    const shared = await made({ type: "agent", id: ADA_ID });
    const block = document.querySelector(".issue-private") as HTMLElement;
    expect(block.textContent).toContain("Só quem está nesta conversa vê esta tarefa.");
    const button = block.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Mostrar para todos");
    await act(async () => button.click());
    await settle(3);
    expect(shared).toHaveLength(1);
  });

  test("a person's only says who sees it", async () => {
    await made({ type: "person", id: "someone" });
    const block = document.querySelector(".issue-private") as HTMLElement;
    expect(block.textContent).toContain("Só quem está nesta conversa");
    expect(block.querySelector("button")).toBeNull();
  });
});
