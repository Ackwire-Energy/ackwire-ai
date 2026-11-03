import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

describe("Aprovações: requests sharing a card", () => {
  test("come together under one head with 'Aprovar tudo', which decides exactly them", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, minutes: number) => ({
      ...merge,
      id,
      tool: "goal_upsert",
      title: `Meta de ${month}`,
      detail: `panel.goal_upsert · month=${month}`,
      params: { month },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, goal("ap-g1", "2026-11", 3), goal("ap-g2", "2026-12", 2));
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    const group = document.querySelector(".ap-group") as HTMLElement;
    expect(group.textContent).toContain("Ada pediu 2 coisas de uma vez");
    expect(within(group).getAllByRole("article")).toHaveLength(2);
    // The request without a card stands alone.
    expect(screen().getByRole("article", { name: "Run deploy workflow" }).closest(".ap-group")).toBeNull();
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "Aprovar tudo" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-g1", "ap-g2"],
      "approve",
    ]);
    expect(state.approvals.filter((a) => a.id.startsWith("ap-g")).map((a) => a.status)).toEqual([
      "approved",
      "approved",
    ]);
  });

  test("waiting requests of one kind in a row: one card, 'Aprovar todos', unfolding into each", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const sql = (id: string, query: string, minutes: number) => ({
      ...merge,
      id,
      tool: "supabase_execute_sql",
      title: "Supabase: Execute sql",
      detail: `execute_sql · query=${query}`,
      params: { query },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, sql("ap-s1", "select 1", 4), sql("ap-s2", "select 2", 3), sql("ap-s3", "select 3", 2));
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    const run = document.querySelector(".ap-run") as HTMLElement;
    expect(run.getAttribute("aria-label")).toMatch(/^3 pedidos de Ada para /);
    // The card is the run: no group head over it, and its requests folded.
    expect(run.closest(".ap-group")).toBeNull();
    expect(within(run).queryAllByRole("article")).toHaveLength(0);
    await act(async () => fireEvent.click(within(run).getByRole("button", { name: "Ver cada um" })));
    expect(within(run).getAllByRole("article")).toHaveLength(3);
    await act(async () =>
      fireEvent.click(within(run).getAllByRole("button", { name: "Aprovar todos" })[0] as HTMLElement),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-s1", "ap-s2", "ap-s3"],
      "approve",
    ]);
  });
});
