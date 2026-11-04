import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { UsageQueue, UsageQueueRow } from "../src/api/types";
import { agentStatusText } from "../src/lib/presence";
import {
  usageQueueFacts,
  usageQueueLine,
  usageQueueMeta,
  usageQueueShared,
  usageQueueState,
  usageQueueTitle,
  usageQueueWhere,
} from "../src/lib/usage-queue";
import { receiptView } from "../src/realtime/receipts";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};
const pt = tFor("pt-BR");
const now = new Date("2026-11-03T12:00:00Z");

const row = (over: Partial<UsageQueueRow> = {}): UsageQueueRow => ({
  runId: "r1",
  kind: "conversation",
  channelId: "c1",
  threadId: null,
  channelKind: "channel",
  channelName: "suporte",
  messageId: "m1",
  askers: ["ana", "bruno"],
  since: new Date(now.getTime() - 3 * 24 * 3600_000).toISOString(),
  after: { count: 12, names: ["Nina", "Ada"] },
  state: "queued",
  title: null,
  mayStop: true,
  ...over,
});
const queue = (over: Partial<UsageQueue> = {}): UsageQueue => ({
  agentId: "theo",
  reason: "plan",
  plan: "Claude",
  resetsAt: "2026-11-03T15:00:00Z",
  sharedWith: [],
  closed: [],
  rows: [row()],
  hidden: 0,
  mayStopAll: true,
  ...over,
});
const person = (id: string) => ({ ana: "Ana", bruno: "Bruno", me: "você" })[id] ?? id;

test("the queue's words: how many, when, where, who asked and what happened since", () => {
  expect(usageQueueTitle(pt, "Theo", queue({ hidden: 3 }))).toBe("Theo tem 4 conversas para retomar");
  expect(usageQueueTitle(pt, "Theo", queue())).toBe("Theo tem 1 conversa para retomar");
  expect(usageQueueLine(pt, "pt-BR", queue(), now)).toMatch(
    /^Retoma às \d\d:00, quando o plano do Claude renovar\. Uma de cada vez, nesta ordem\.$/,
  );
  expect(usageQueueLine(pt, "pt-BR", queue({ resetsAt: null }), now)).toBe(
    "Retoma assim que o plano do Claude renovar. Uma de cada vez, nesta ordem.",
  );
  expect(usageQueueShared(pt, "Theo", ["Ada"])).toBe("A fila é do plano: Ada e Theo dividem a mesma conta.");
  expect(usageQueueShared(pt, "Theo", [])).toBeNull();
  expect(usageQueueWhere(pt, row(), "me", person)).toBe("#suporte");
  expect(usageQueueWhere(pt, row({ threadId: "t1" }), "me", person)).toBe("Conversa em #suporte");
  expect(usageQueueWhere(pt, row({ channelKind: "dm", channelName: null, askers: ["bruno"] }), "me", person)).toBe(
    "DM com Bruno",
  );
  expect(usageQueueWhere(pt, row({ channelKind: "dm", askers: ["me"] }), "me", person)).toBe("Sua DM");
  expect(usageQueueWhere(pt, row({ kind: "routine", title: "Resumo diário", askers: [] }), "me", person)).toBe(
    "Rotina Resumo diário",
  );
  expect(usageQueueMeta(pt, "pt-BR", row(), person, now)).toMatch(/^Pedido por Ana e Bruno · /);
  expect(usageQueueFacts(pt, row())).toBe("12 mensagens depois · Nina e Ada escreveram depois");
  expect(usageQueueFacts(pt, row({ after: { count: 1, names: ["Nina"] } }))).toBe(
    "1 mensagem depois · Nina escreveu depois",
  );
  expect(usageQueueFacts(pt, row({ after: { count: 0, names: [] } }))).toBe("Nada depois");
  // The viewer's own messages are theirs: "você", not their own name.
  expect(usageQueueFacts(pt, row({ after: { count: 3, names: ["Heitor Lima"] } }), "Heitor Lima")).toBe(
    "3 mensagens depois · você escreveu depois",
  );
  expect(usageQueueState(pt, row())).toBe("Na fila");
  expect(usageQueueState(pt, row({ state: "answering" }))).toBe("Respondendo agora");
});

test("an agent out of office with conversations waiting says how many", () => {
  const line = {
    by: "auto" as const,
    text: null,
    kind: "out_of_plan" as const,
    subject: null,
    emoji: null,
    until: null,
    count: 7,
  };
  expect(agentStatusText(pt, line, "pt-BR", now)?.text).toBe("Sem limite no plano · 7 conversas esperando");
  expect(agentStatusText(pt, { ...line, count: undefined }, "pt-BR", now)?.text).toBe("Sem limite no plano");
});

test("long work in the agent's line of work reads as in line, not as waiting for your answer", () => {
  const view = receiptView({ routed: true, server: undefined, agents: [["ada", "line"]] } as never);
  expect(view.status).toEqual({ kind: "line", agents: ["ada"] });
  expect(pt("receipts.line", { count: 1, names: "Ada" })).toBe("Ada começa quando terminar outro trabalho");
});
