import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MissionCommand, MissionDecision } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

async function setup() {
  const api = createFakeApi(seedState());
  const mission = await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "App mobile", channelId: ENG_ID });
  const command: MissionCommand = {
    id: "00000000-0000-4000-8000-00000000cc01",
    missionId: mission.id,
    taskId: "00000000-0000-4000-8000-00000000aa01",
    tool: "Bash",
    command: "swift build -c release",
    state: "pending",
    rules: ["Bash(swift build *)"],
    decidedBy: null,
    decidedAt: null,
    always: false,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const decision: MissionDecision = {
    id: "00000000-0000-4000-8000-00000000dd01",
    missionId: mission.id,
    taskId: null,
    messageId: "msg-decision-1",
    question: "Expo ou React Native puro?",
    options: ["Expo", "React Native"],
    recommendation: "Expo",
    why: null,
    impact: null,
    blocking: true,
    status: "pending",
    chosen: null,
    chosenBy: null,
    chosenAt: null,
    opinions: [],
    createdAt: new Date().toISOString(),
  };
  const decided: string[] = [];
  const waiting = {
    ...mission,
    canAct: true,
    pending: { ...mission.pending, commands: 1, decisions: 1 },
  };
  api.missions.list = async (_org, query) =>
    query?.status === "waiting_you"
      ? { missions: [waiting], counts: { active: 1, waitingYou: 1, closed: 0 } }
      : { missions: [], counts: { active: 1, waitingYou: 1, closed: 0 } };
  api.missions.get = async () => ({ ...waiting });
  api.missions.commands = async () => ({ commands: [{ ...command }], rules: [] });
  api.missions.decisions = async () => [{ ...decision }];
  api.missions.decideCommand = async (_org, _mission, _id, d) => {
    decided.push(d);
    Object.assign(command, { state: d === "deny" ? "denied" : "allowed", always: d === "always" });
    return { ...command };
  };
  return { api, mission, decided };
}

describe("Aprovações: missions", () => {
  test("a pending command card with its mission, Aprovar / Recusar / Aprovar sempre, counted in Esperando você", async () => {
    const { api, decided } = await setup();
    const approvals = (await api.approvals.list(ORG_ID)).filter((a) => a.status === "pending").length;
    await renderApp(`/org/${ORG_ID}/approvals`, { api });
    await settle(8);
    const section = screen().getByRole("region", { name: "Comandos para aprovar" });
    expect(section.textContent).toContain("swift build -c release");
    expect(section.textContent).toContain("App mobile");
    expect(within(section).getByRole("link", { name: "App mobile" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Recusar" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: /Aprovar sempre/ })).toBeTruthy();
    const pill = within(screen().getByRole("radiogroup", { name: "Filtro" })).getByRole("radio", {
      name: /^Esperando você/,
    });
    expect(pill.textContent).toBe(`Esperando você${approvals + 1}`);
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Aprovar" })));
    await settle(4);
    expect(decided).toEqual(["allow"]);
  });

  test("Esperando você em missões: a pending decision links to its card in the thread", async () => {
    const { api, mission } = await setup();
    await renderApp(`/org/${ORG_ID}/approvals`, { api });
    await settle(8);
    const list = screen().getByRole("region", { name: "Esperando você em missões" });
    expect(list.textContent).toContain("Expo ou React Native puro?");
    expect(list.textContent).toContain("Decisão");
    const open = within(list).getByRole("link", { name: "Abrir" });
    expect(open.getAttribute("href")).toBe(`/org/${ORG_ID}/threads/${mission.threadId}?m=msg-decision-1`);
  });
});

describe("Aprovações: a request's details", () => {
  test("how it got here: each step's dot leads its text's first line", async () => {
    const state = seedState();
    const at = new Date().toISOString();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (merge)
      merge.trail = [
        { text: "O João pediu a correção do login", at },
        { text: "A Ada abriu o PR #42 com a correção", at },
      ];
    await renderApp(`/org/${ORG_ID}/approvals?open=ap-merge`, { api: createFakeApi(state) });
    await settle(8);
    const steps = [...document.querySelectorAll(".ap-trail li")];
    expect(steps.length).toBe(3);
    for (const step of steps) {
      expect(step.classList.contains("ac-iconline")).toBe(true);
      expect(step.firstElementChild?.classList.contains("ap-trail__dot")).toBe(true);
    }
  });
});
