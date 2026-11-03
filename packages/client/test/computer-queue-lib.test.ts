import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { ComputerQueue } from "../src/api/types";
import {
  awayText,
  fanChipText,
  fanOutOf,
  fanOutText,
  fanShows,
  nthText,
  queueAllStartedText,
  queueButtonText,
  queuedNextText,
  queueLiveText,
  queuePurposeText,
  queueStartText,
  queueStatusText,
  queueView,
  queueWhereText,
  waitingFor,
} from "../src/lib/computer-queue";
import type { MessageReceipt } from "../src/realtime/receipts";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};
const en = tFor("en");
const pt = tFor("pt-BR");

const NOW = Date.parse("2026-11-02T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const NAMES: Record<string, string> = { ada: "Ada", kai: "Kai", rio: "Rio", nova: "Nova", theo: "Theo" };
const agentName = (id: string) => NAMES[id];
const where = { channelId: "c1", threadId: null };

const queue: ComputerQueue = {
  machineId: "m1",
  name: "Studio",
  working: [
    {
      runId: "w1",
      agentId: "ada",
      purpose: { kind: "agent", agentId: "kai" },
      where,
      startedAt: at(-6),
      estimatedEndAt: at(1),
    },
  ],
  waiting: [
    {
      runId: "q1",
      agentId: "theo",
      purpose: { kind: "person", userId: "me" },
      where,
      people: true,
      position: 1,
      estimatedStartAt: at(1),
      after: ["ada"],
    },
    {
      runId: "q2",
      agentId: "kai",
      purpose: { kind: "agent", agentId: "ada" },
      where,
      people: false,
      position: 2,
      estimatedStartAt: at(3),
      after: ["theo"],
    },
    {
      runId: "q3",
      agentId: "rio",
      purpose: { kind: "routine" },
      where,
      people: false,
      position: 3,
      estimatedStartAt: null,
      after: ["theo", "kai"],
    },
    {
      runId: "q4",
      agentId: "nova",
      purpose: { kind: "work" },
      where,
      people: false,
      position: 4,
      estimatedStartAt: null,
      after: ["theo", "kai", "rio"],
    },
  ],
};

test("the view: the viewer's own request is marked, the computer full, the next start known, the last one not", () => {
  const view = queueView(queue, "me");
  expect(view.waiting.map((w) => w.mine)).toEqual([true, false, false, false]);
  expect(view.full).toBe(true);
  expect(queueStatusText(en, view, NOW)).toBe("Full · next starts in about 1 min");
  expect(queueAllStartedText(en, view, NOW)).toBeNull();
  expect(queueButtonText(en, queue)).toBe("Computer · 4 waiting");
  expect(queueButtonText(pt, { ...queue, waiting: [] })).toBe("Computador");
  expect(queueStatusText(en, queueView({ ...queue, waiting: [] }, "me"), NOW)).toBe("Nobody in line");
  const known = queueView({ ...queue, waiting: queue.waiting.slice(0, 2) }, "me");
  expect(queueAllStartedText(pt, known, NOW)).toBe("todos começam em ~3 min");
  // One in line: its row already says when it starts.
  expect(queueAllStartedText(en, queueView({ ...queue, waiting: queue.waiting.slice(0, 1) }, "me"), NOW)).toBeNull();
});

test("an agent's turn for a message: the run its receipt follows, else its one turn waiting in that conversation", () => {
  expect(waitingFor(queue, { runOf: { theo: "q1" } }, "theo", "elsewhere")?.runId).toBe("q1");
  expect(waitingFor(queue, undefined, "kai", "c1")?.runId).toBe("q2");
  expect(waitingFor(queue, undefined, "kai", "c2")).toBeNull();
  expect(waitingFor(null, undefined, "theo", "c1")).toBeNull();
});

test("the agent's live row: next with an estimate, next once a turn ends, further back after the ones ahead", () => {
  expect(queueLiveText(en, "en", queue, "q1", agentName, NOW)).toBe(
    "Waiting for the computer. Next up, in about 1 min",
  );
  const noEta = { ...queue, waiting: queue.waiting.map((w) => ({ ...w, estimatedStartAt: null })) };
  expect(queueLiveText(en, "en", noEta, "q1", agentName, NOW)).toBe(
    "Waiting for the computer. Next up, once Ada finishes",
  );
  expect(queueLiveText(pt, "pt-BR", noEta, "q1", agentName, NOW)).toBe(
    "Aguardando o computador. É o próximo quando a Ada terminar",
  );
  expect(queueLiveText(en, "en", queue, "q4", agentName, NOW)).toBe("In line, 4th. After Theo, Kai, and Rio");
  expect(queueLiveText(pt, "pt-BR", queue, "q2", agentName, NOW)).toBe("Na fila, 2º. Depois de Theo");
  expect(queueLiveText(en, "en", queue, "elsewhere", agentName, NOW)).toBeNull();
  expect(queuedNextText(pt, "Ada")).toBe("Ada está na fila do computador · é a próxima");
  expect(queuedNextText(en, "Theo")).toBe("Theo is in line for the computer · next");
});

test("rows: what each turn is for, never its content, where, and its estimate", () => {
  const names = { viewerId: "me", agent: agentName, person: (id: string) => (id === "u2" ? "Bia" : undefined) };
  expect(queuePurposeText(en, { kind: "person", userId: "me" }, names)).toBe("answering you");
  expect(queuePurposeText(en, { kind: "person", userId: "u2" }, names)).toBe("answering Bia");
  expect(queuePurposeText(en, { kind: "person", userId: null }, names)).toBe("answering a person");
  expect(queuePurposeText(pt, { kind: "agent", agentId: "kai" }, names)).toBe("a pedido de Kai");
  expect(queuePurposeText(en, { kind: "routine" }, names)).toBe("a routine");
  expect(queueWhereText(en, { kind: "channel", name: "dev", thread: false })).toBe("#dev");
  expect(queueWhereText(en, { kind: "dm", mine: true })).toBe("your DM");
  expect(queueWhereText(en, { kind: "dm", mine: false, withName: "Theo" })).toBe("DM with Theo");
  expect(queueWhereText(en, { kind: "hidden" })).toBe("a private conversation");
  expect(queueStartText(en, queue.waiting[1] as never, agentName, NOW)).toBe("starts ~3 min");
  expect(queueStartText(pt, { ...queue.waiting[0], estimatedStartAt: null } as never, agentName, NOW)).toBe(
    "começa quando a Ada terminar",
  );
  expect(queueStartText(en, queue.waiting[3] as never, agentName, NOW)).toBeNull();
  expect(awayText(en, at(-3), NOW)).toBe("Away 3 min");
});

test("ordinals by the language's own rule", () => {
  expect([1, 2, 3, 4, 11, 21, 22].map((n) => nthText(en, "en", n))).toEqual([
    "1st",
    "2nd",
    "3rd",
    "4th",
    "11th",
    "21st",
    "22nd",
  ]);
  expect(nthText(pt, "pt-BR", 3)).toBe("3º");
});

test("fan-out: each called agent answered, working or its place in line, from receipts and the computer's line", () => {
  const receipt: MessageReceipt = {
    routed: true,
    byAgent: true,
    mentioned: ["ada", "kai", "theo", "rio", "nova", "gone"],
    referenced: ["gone"],
    agents: [
      ["ada", "handled"],
      ["kai", "queued"],
      ["theo", "claimed"],
      ["rio", "queued"],
    ],
    runOf: { kai: "q2", rio: "q3", theo: "w9" },
  };
  const fan = fanOutOf(receipt, queue);
  expect(fan).toMatchObject({ called: 5, answered: 1, working: 1, inLine: 3, failed: 0 });
  expect(fan?.agents).toEqual([
    { agentId: "ada", state: "answered", position: null },
    { agentId: "theo", state: "working", position: null },
    { agentId: "kai", state: "inLine", position: 2 },
    { agentId: "rio", state: "inLine", position: 3 },
    // Not started yet (paced): in line, place not known.
    { agentId: "nova", state: "inLine", position: null },
  ]);
  expect(fanOutText(en, fan as never)).toBe("5 agents called · 1 answered · 1 working · 3 in line");
  expect(fanOutText(pt, fan as never)).toBe("5 agentes chamados · 1 respondeu · 1 trabalhando · 3 na fila");
  expect(fan?.agents.map((a) => fanChipText(en, "en", a))).toEqual(["answered", "working", "2nd", "3rd", "in line"]);
  // One agent called is no fan-out.
  expect(fanOutOf({ routed: true, agents: [["ada", "handled"]], mentioned: ["ada"] })).toBeNull();
});

test("the fan-out strip: under an agent's message, once two called agents started, while one works or waits", () => {
  const agent = { author: { type: "agent" } } as never;
  const person = { author: { type: "person" } } as never;
  const receipt = (phases: [string, "handled" | "claimed" | "picked"][], runOf: Record<string, string>) =>
    ({ routed: true, agents: phases, mentioned: phases.map(([id]) => id), runOf }) as MessageReceipt;
  const both = receipt(
    [
      ["ada", "handled"],
      ["rio", "claimed"],
    ],
    { ada: "r1", rio: "r2" },
  );
  expect(fanShows(agent, fanOutOf(both, queue), both)).toBe(true);
  expect(fanShows(person, fanOutOf(both, queue), both)).toBe(false);
  // One started: the receipt says it.
  const one = receipt(
    [
      ["ada", "claimed"],
      ["rio", "picked"],
    ],
    { ada: "r1" },
  );
  expect(fanShows(agent, fanOutOf(one, queue), one)).toBe(false);
  // All answered: each reply says it.
  const done = receipt(
    [
      ["ada", "handled"],
      ["rio", "handled"],
    ],
    { ada: "r1", rio: "r2" },
  );
  expect(fanShows(agent, fanOutOf(done, queue), done)).toBe(false);
});
