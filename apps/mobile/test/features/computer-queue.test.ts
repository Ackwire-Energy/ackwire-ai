import { describe, expect, test } from "bun:test";
import type { ComputerQueue, QueueWaiting } from "@agenteschat/client";
import {
  queueCauseText,
  queueLiveText,
  queueStoppable,
  queueStopText,
  queueWhereText,
  waitingFor,
} from "@agenteschat/client/lib/computer-queue";
import { devicePlanName } from "@agenteschat/client/lib/no-ai";
import { machineOfAgents, queuePlace } from "../../src/features/queue/logic";
import { translator } from "./fixtures";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

const wait = (over: Partial<QueueWaiting> & Pick<QueueWaiting, "runId" | "agentId" | "position">): QueueWaiting => ({
  purpose: { kind: "person", userId: "me" },
  where: { channelId: "dm1", threadId: null },
  people: true,
  estimatedStartAt: null,
  after: [],
  ...over,
});

const queue: ComputerQueue = {
  machineId: "m1",
  name: "Studio",
  working: [
    {
      runId: "w1",
      agentId: "ada",
      purpose: { kind: "agent", agentId: "kai" },
      where: { channelId: "dev", threadId: null },
      startedAt: at(-4),
      estimatedEndAt: at(1),
    },
  ],
  waiting: [
    wait({ runId: "q1", agentId: "nova", position: 1, estimatedStartAt: at(1), after: ["ada"] }),
    wait({
      runId: "q2",
      agentId: "rio",
      position: 2,
      people: false,
      purpose: { kind: "agent", agentId: "ada" },
      where: { channelId: "dev", threadId: "t1" },
      after: ["nova"],
    }),
  ],
};

describe("a shared computer's line on the phone", () => {
  test("a row's press sits beside the agent's face, never around it: VoiceOver reaches both", async () => {
    const sheet = await Bun.file(new URL("../../src/features/queue/QueueSheet.tsx", import.meta.url)).text();
    const line = sheet.slice(sheet.indexOf("export function QueueLine"));
    expect(line.indexOf("</OpensAgent>")).toBeLessThan(line.indexOf("<Pressable"));
    expect(sheet.slice(sheet.indexOf("function ActiveLine"), sheet.indexOf("function WorkingRow"))).not.toContain(
      "<Pressable",
    );
  });

  test("the computer the conversation's agents share: the first one that has one", () => {
    const machines = [
      { id: "m1", agents: [{ id: "nova" }, { id: "rio" }] },
      { id: "m2", agents: [{ id: "ada" }] },
    ] as Parameters<typeof machineOfAgents>[0];
    expect(machineOfAgents(machines, ["kai", "ada", "nova"])).toBe("m2");
    expect(machineOfAgents(machines, ["kai"])).toBeNull();
    expect(machineOfAgents(undefined, ["nova"])).toBeNull();
  });

  test("where a turn answers: my DM, a channel or its thread, else a private conversation", async () => {
    const channels = [
      { id: "dev", name: "dev", visibility: "public" as const, isMember: true },
      { id: "secret", name: "secret", visibility: "private" as const, isMember: false },
    ];
    const dms = [{ channelId: "dm1" }];
    const en = await translator("en");
    const say = (channelId: string, threadId: string | null = null) =>
      queueWhereText(en, queuePlace({ channelId, threadId }, channels, dms));
    expect(say("dm1")).toBe("your DM");
    expect(say("dev")).toBe("#dev");
    expect(say("dev", "t1")).toBe("a thread in #dev");
    expect(say("secret")).toBe("a private conversation");
    expect(say("someone-elses-dm")).toBe("a private conversation");
    expect(queueWhereText(en, queuePlace({ channelId: "x", threadId: null, agents: true }, channels, dms))).toBe(
      "a conversation between agents",
    );
  });

  test("an agent's turn for a message: the run its receipt follows, else its one turn waiting here", async () => {
    expect(waitingFor(queue, { runOf: { nova: "q1" } }, "nova", "elsewhere")?.runId).toBe("q1");
    expect(waitingFor(queue, undefined, "rio", "dev")?.runId).toBe("q2");
    expect(waitingFor(queue, undefined, "rio", "dm1")).toBeNull();
    expect(waitingFor(null, undefined, "nova", "dm1")).toBeNull();
    const en = await translator("en");
    const names: Record<string, string> = { ada: "Ada", nova: "Nova", rio: "Rio" };
    const name = (id: string) => names[id];
    expect(queueLiveText(en, "en", queue, "q1", name, NOW)).toBe("Waiting for the computer. Next up, in about 1 min");
    expect(queueLiveText(en, "en", queue, "q2", name, NOW)).toBe("In line, 2nd. After Nova");
  });

  test("the wait's cause, as the web says it: what holds the computer's memory now; nothing on an empty one", async () => {
    const pt = await translator("pt-BR");
    expect(queueCauseText(pt, queue)).toBe("Computador cheio: 1 trabalho usa a memória agora (1 pedida por agente).");
    const en = await translator("en");
    expect(queueCauseText(en, { working: [] })).toBeNull();
    expect(queueCauseText(en, null)).toBeNull();
  });

  test("the wait's way out, as the web says it: the work I may stop, a routine before an agent's ask, never a reply", async () => {
    const pt = await translator("pt-BR");
    expect(queueStoppable(queue)).toBeUndefined();
    const [ask] = queue.working;
    const reply = { ...ask, runId: "w2", purpose: { kind: "person", userId: "u2" }, canStop: true } as const;
    const routine = { ...ask, runId: "w3", purpose: { kind: "routine" }, canStop: true } as const;
    expect(queueStoppable({ working: [reply] })).toBeUndefined();
    const freeing = queueStoppable({ working: [reply, { ...ask, canStop: true }, routine] });
    expect(freeing?.runId).toBe("w3");
    expect(freeing && queueStopText(pt, freeing, "Ada")).toBe("Parar a rotina");
    expect(queueStopText(pt, { purpose: { kind: "agent", agentId: "kai" } }, "Ada")).toBe("Parar Ada");
  });

  test("a computer's plan in the line's spill-over list: its own sign-in, else an account of mine there", async () => {
    const pt = await translator("pt-BR");
    const computer = { machineId: "m2", name: "MacBook", online: true, mine: true, canAdd: true, keys: true };
    const brains = { claude_code: true, codex: true };
    expect(
      devicePlanName(
        pt,
        { accounts: [], computers: [{ ...computer, brains, own: { claude_code: { plan: "max" } } }] },
        "m2",
      ),
    ).toBe("Claude Max");
    expect(devicePlanName(pt, { accounts: [], computers: [{ ...computer, brains }] }, "m2")).toBeNull();
    expect(devicePlanName(pt, undefined, "m2")).toBeNull();
  });
});
