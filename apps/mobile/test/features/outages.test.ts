import { describe, expect, test } from "bun:test";
import type { Agent } from "@agenteschat/client";
import { type OutageTargetLike, targetOptions, waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { teamLines, type WorkItem } from "../../src/features/agents/logic";
import { agentRowState } from "../../src/features/chats/now";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import {
  computerIcon,
  type MachineOutage,
  moveToast,
  namesText,
  noticeText,
  sheetDesc,
  targetText,
  waitCardText,
  waitingText,
} from "../../src/features/outages/logic";
import { withMobileKeys } from "../../src/i18n/merge";

async function translator(lng: "pt-BR" | "en"): Promise<TFunction> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: "pt-BR",
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    interpolation: { escapeValue: false },
  });
  return i18n.t;
}

const air: MachineOutage = {
  machineId: "air",
  name: "MacBook Air",
  platform: "darwin",
  offlineSince: "2026-10-18T20:00:00.000Z",
  waitingRuns: 3,
  agents: [
    { agentId: "ada", name: "Ada", brain: "claude_code", waiting: { routines: 2, conversations: 0 } },
    { agentId: "theo", name: "Theo", brain: "claude_code", waiting: { routines: 0, conversations: 1 } },
  ],
};
const pro: OutageTargetLike = {
  kind: "machine",
  machineId: "pro",
  name: "MacBook Pro do Walter",
  platform: "darwin",
  online: true,
  brains: ["claude_code"],
  reasonOff: null,
};
const office: OutageTargetLike = {
  kind: "machine",
  machineId: "office",
  name: "PC do escritório",
  platform: "windows",
  online: false,
  brains: ["claude_code"],
  reasonOff: "offline",
};

describe("Computador desconectado (phone)", () => {
  test("the notice, as in the prototype", async () => {
    const t = await translator("pt-BR");
    expect(noticeText(t, air)).toEqual({
      title: "O MacBook Air desconectou",
      sub: "Ada e Theo esperam por ele · 3 tarefas",
    });
    const one = { ...air, waitingRuns: 1, agents: [air.agents[0]] } as MachineOutage;
    expect(noticeText(t, one).sub).toBe("Ada espera por ele · 1 tarefa");
    expect(namesText(t, ["Ada", "Theo", "Atlas", "Lisa"])).toBe("Ada, Theo e mais 2");
    const en = await translator("en");
    expect(noticeText(en, air)).toEqual({
      title: "MacBook Air disconnected",
      sub: "Ada and Theo are waiting for it · 3 tasks",
    });
  });

  test("the sheet: who waits for what, the targets' lines, the line under the title", async () => {
    const t = await translator("pt-BR");
    expect(waitingText(t, air.agents[0] as MachineOutage["agents"][number])).toBe("2 rotinas esperando");
    expect(waitingText(t, air.agents[1] as MachineOutage["agents"][number])).toBe("1 conversa esperando");
    expect(sheetDesc(t, air, new Set(["ada", "theo"]))).toBe(
      "O MacBook Air está desconectado. Escolha onde Ada e Theo passam a trabalhar.",
    );
    expect(sheetDesc(t, air, new Set(["ada"]))).toBe(
      "O MacBook Air está desconectado. Escolha onde Ada passa a trabalhar.",
    );
    const [on, off, cloud] = targetOptions(air, [office, pro, { kind: "cloud", available: true, brains: [] }], ["ada"]);
    expect(on && targetText(t, on)).toEqual({
      title: "MacBook Pro do Walter",
      tag: "Ligado",
      desc: "Tem o Claude Code",
    });
    expect(off && targetText(t, off)).toEqual({ title: "PC do escritório", tag: null, desc: "Desconectado" });
    expect(cloud && targetText(t, cloud)).toEqual({
      title: "Computador na nuvem",
      tag: null,
      desc: "Não tem o Claude Code",
    });
    const paused = targetOptions(air, [{ ...pro, reasonOff: "paused" }], ["ada"])[0];
    expect(paused && targetText(t, paused).desc).toBe("Pausado");
    const odd = targetOptions(air, [{ ...pro, reasonOff: "something_new" }], ["ada"])[0];
    expect(odd && targetText(t, odd).desc).toBe("Não dá para usar agora");
    const able = targetOptions(air, [{ kind: "cloud", available: true, brains: ["claude_code"] }], ["ada"])[0];
    expect(able && targetText(t, able)).toMatchObject({ tag: "Sempre ligado" });
    expect(computerIcon("darwin")).toBe("computerMac");
    expect(computerIcon("windows")).toBe("computerWindows");
    expect(computerIcon("linux")).toBe("computerLinux");
    expect(computerIcon(null, true)).toBe("computerCloud");
  });

  test("the toast after switching", async () => {
    const t = await translator("pt-BR");
    expect(moveToast(t, { moved: ["ada", "theo"], skipped: [], resumed: 2, stillWaiting: 1 }, "MacBook Air")).toEqual({
      title: "2 agentes trocaram de computador",
      subtitle: "2 tarefas já seguiram · 1 tarefa espera o MacBook Air",
      ok: true,
    });
    expect(
      moveToast(t, { moved: [], skipped: [{ agentId: "ada", reason: "x" }], resumed: 0, stillWaiting: 0 }, "X"),
    ).toEqual({ title: "Ninguém trocou de computador", subtitle: undefined, ok: false });
  });

  test("the chat's card: waiting, back, moved", async () => {
    const t = await translator("pt-BR");
    const waiting = waitCardText(
      t,
      { kind: "waiting", machineId: "air", computer: "MacBook Air", waiting: air.agents[0] ?? null },
      "claude_code",
      null,
    );
    expect(waiting).toEqual({
      title: "Esperando o MacBook Air voltar",
      body: "O Claude Code roda nele. Sigo daqui assim que ele voltar · 2 rotinas esperando",
      done: false,
    });
    expect(waitCardText(t, { kind: "back", machineId: "air" }, "claude_code", "MacBook Air")).toMatchObject({
      title: "O MacBook Air voltou",
      done: true,
    });
    expect(waitCardText(t, { kind: "back", machineId: "air" }, "claude_code", null)?.title).toBe("O computador voltou");
    expect(waitCardText(t, { kind: "moved", machineId: "air", computer: "MacBook Air" }, "codex", null)?.done).toBe(
      true,
    );
    expect(waitCardText(t, { kind: "unknown" }, "codex", null)).toBeNull();
  });

  test("agents waiting for the computer: their row says so, never working", () => {
    const offline = waitingComputerByAgent([air]);
    const work: WorkItem[] = [
      {
        key: "r:1",
        kind: "run",
        agentId: "ada",
        channelId: "d1",
        threadId: null,
        what: "x",
        since: "2026-10-18T20:00:00.000Z",
      } as WorkItem,
    ];
    expect(agentRowState("ada", "d1", work, [], offline)).toEqual({ kind: "computer", computer: "MacBook Air" });
    // Waiting on your ok still wins.
    expect(
      agentRowState("ada", "d1", work, [{ agentId: "ada", kind: "approval", title: "Merge" }], offline),
    ).toMatchObject({
      kind: "waiting",
    });
    expect(agentRowState("ada", "d1", work, [])).toMatchObject({ kind: "working" });

    const agent = (id: string, name: string) => ({ id, name, role: "", instructions: "" }) as unknown as Agent;
    const { working, free } = teamLines([agent("ada", "Ada"), agent("atlas", "Atlas")], work, [], [], offline);
    expect(working).toEqual([]);
    expect(free.map((l) => [l.agent.id, l.computer])).toEqual([
      ["ada", "MacBook Air"],
      ["atlas", undefined],
    ]);
  });
});
