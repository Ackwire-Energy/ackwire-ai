import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { Message, MissionCommand } from "@/api/types";
import { commandApprovalOptions } from "@/components/missions/MissionBits";
import { AutoApprovedLine, groupAutoApproved } from "@/components/missions/MissionCards";
import { BlockedCommands, MissionCommandCard, ruleText } from "@/components/missions/MissionCommandCard";
import { createI18n } from "@/i18n";
import { machineTaskOf, missionAutoApprovedOf, missionCommandOf } from "@/lib/missions";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function withCommand() {
  const state = seedState();
  const api = createFakeApi(state);
  const mission = await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "Fotos", channelId: ENG_ID });
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
  const decided: string[] = [];
  api.missions.commands = async () => ({ commands: [{ ...command }], rules: [] });
  api.missions.decideCommand = async (_org, _mission, _id, decision) => {
    decided.push(decision);
    Object.assign(command, { state: decision === "deny" ? "denied" : "allowed", always: decision === "always" });
    return { ...command };
  };
  return { api, mission, command, decided, state };
}

describe("command approvals", () => {
  test("the card shows the command and Aprovar / Recusar / Aprovar sempre; answering says who and when", async () => {
    const { api, mission, command, decided } = await withCommand();
    await renderPage(
      <MissionCommandCard
        command={{
          id: command.id,
          missionId: mission.id,
          taskId: command.taskId,
          tool: "Bash",
          command: command.command,
        }}
      />,
      { api, org: true },
    );
    await settle(6);
    const card = screen().getByRole("region", { name: "Claude Code pede para rodar um comando" });
    expect(card.textContent).toContain("swift build -c release");
    expect(card.textContent).toContain("Aprovar sempre libera swift build …");
    expect(within(card).getByRole("button", { name: "Recusar" })).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aprovar sempre nesta missão" })));
    await settle(6);
    expect(decided).toEqual(["always"]);
    expect(card.textContent).toContain("Liberado nesta missão");
    expect(within(card).queryByRole("button", { name: "Recusar" })).toBeNull();
  });

  test("a task's blocked commands: Liberar e repetir for whoever decides (active missions)", async () => {
    const { api, mission, state } = await withCommand();
    await api.missions.control(ORG_ID, mission.id, "start");
    await renderPage(
      <BlockedCommands
        missionId={mission.id}
        taskId="00000000-0000-4000-8000-00000000aa01"
        blocked={[{ tool: "Bash", command: "python3 -c 'import PIL'" }]}
      />,
      { api, org: true },
    );
    await settle(6);
    const list = screen().getByRole("list", { name: "Comandos bloqueados" });
    expect(list.textContent).toContain("Bloqueado:");
    expect(list.textContent).toContain("python3 -c 'import PIL'");
    await act(async () => fireEvent.click(within(list).getByRole("button", { name: "Liberar e repetir" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "missions.retryCommand")?.args[2]).toEqual({
      taskId: "00000000-0000-4000-8000-00000000aa01",
      command: "python3 -c 'import PIL'",
    });
  });

  test("meta readers and rule text", () => {
    expect(
      missionCommandOf({ missionCommand: { id: "c1", missionId: "m1", taskId: "t1", tool: "Bash", command: "ls" } }),
    ).toEqual({ id: "c1", missionId: "m1", taskId: "t1", tool: "Bash", command: "ls" });
    expect(missionCommandOf({})).toBeNull();
    expect(
      machineTaskOf({ machineTask: { id: "t1", blocked: [{ tool: "Bash", command: "git init" }, { x: 1 }] } })?.blocked,
    ).toEqual([{ tool: "Bash", command: "git init" }]);
    expect(ruleText("Bash(swift build *)")).toBe("swift build …");
    expect(ruleText("WebFetch(domain:x.dev)")).toBe("x.dev");
  });

  const autoMessage = (id: string, missionId: string, command: string, at: number, reason = "low_risk"): Message => ({
    id,
    channelId: ENG_ID,
    threadId: "root",
    author: { type: "agent", id: ADA_ID },
    body: `Allowed automatically: ${command}`,
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {
      missionAutoApproved: { missionId, taskId: "t1", tool: "Bash", command, reason },
      bodyCode: "mission_auto_approved",
    },
    createdAt: new Date(at).toISOString(),
  });

  test("a command Jev approved: one quiet line with the command and Revogar (back to asking for every one)", async () => {
    const { api, mission, state } = await withCommand();
    expect(mission.commandApproval).toBe("low_risk_auto");
    await renderPage(
      <AutoApprovedLine messages={[autoMessage("a1", mission.id, "swift build -c release", Date.now())]} />,
      {
        api,
        org: true,
      },
    );
    await settle(6);
    const line = document.querySelector(".mi-evt--auto") as HTMLElement;
    expect(line.textContent).toContain("Aprovado automaticamente:");
    expect(line.querySelector("code")?.textContent).toBe("swift build -c release");
    expect(line.textContent).toContain("baixo risco");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Revogar" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "missions.setCommandApproval")?.args[2]).toBe("always");
    expect(within(line).queryByRole("button", { name: "Revogar" })).toBeNull();
  });

  test("several within a minute: one line ('3 comandos', Ver comandos); a gap starts a new line", async () => {
    const { api, mission } = await withCommand();
    const t0 = Date.now() - 120_000;
    const list = [
      autoMessage("a1", mission.id, "swift build", t0),
      autoMessage("a2", mission.id, "swift test", t0 + 20_000),
      autoMessage("a3", mission.id, "make lint", t0 + 50_000),
      autoMessage("a4", mission.id, "make docs", t0 + 90_000),
    ];
    const { groups, hidden } = groupAutoApproved(list);
    expect([...groups.keys()]).toEqual(["a1", "a4"]);
    expect(groups.get("a1")?.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect([...hidden]).toEqual(["a2", "a3"]);
    expect(missionAutoApprovedOf(list[0]?.meta ?? {})).toMatchObject({ command: "swift build", reason: "low_risk" });
    expect(missionAutoApprovedOf({})).toBeNull();
    await renderPage(<AutoApprovedLine messages={groups.get("a1") ?? []} />, { api, org: true });
    await settle(6);
    const line = document.querySelector(".mi-evt--auto") as HTMLElement;
    expect(line.textContent).toContain("3 comandos");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Ver comandos" })));
    expect([...line.querySelectorAll("li code")].map((c) => c.textContent)).toEqual([
      "swift build",
      "swift test",
      "make lint",
    ]);
  });

  test("Pedir aprovação de comandos: the three options, the default first", () => {
    expect(commandApprovalOptions(createI18n("pt-BR").t).map((o) => o.label)).toEqual([
      "Só os arriscados (Jev aprova os de baixo risco)",
      "Sempre",
      "Nunca (exceto os bloqueados)",
    ]);
    expect(commandApprovalOptions(createI18n("en").t).map((o) => o.value)).toEqual([
      "low_risk_auto",
      "always",
      "never",
    ]);
  });
});
