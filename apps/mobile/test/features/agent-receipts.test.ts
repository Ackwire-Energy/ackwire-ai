import { describe, expect, test } from "bun:test";
import {
  type AiStatus,
  applyReceiptEvent,
  type DecidedBy,
  type ReceiptsState,
  receiptView,
  seedReceipt,
} from "@agenteschat/client";
import { deciderOf } from "@agenteschat/client/lib/routing";
import {
  phaseKey,
  receiptLine,
  receiptMessageId,
  receiptRows,
  receiptShows,
} from "../../src/features/chat/agent-receipts";
import { endsOnNoAiCard, noAiBanner } from "../../src/features/chat/no-ai-banner";
import { message, translator } from "./fixtures";

const routed = (
  state: ReceiptsState,
  over: { seenBy?: string[]; pickedBy?: string[]; reason?: string; decidedBy?: DecidedBy } = {},
) =>
  applyReceiptEvent(state, {
    type: "message.routed",
    channelId: "c1",
    messageId: "m1",
    seenBy: over.seenBy ?? ["ada", "theo"],
    pickedBy: over.pickedBy ?? ["ada"],
    ...(over.reason ? { reason: over.reason } : {}),
    ...(over.decidedBy ? { decidedBy: over.decidedBy } : {}),
  });
const picking = (state: ReceiptsState) =>
  applyReceiptEvent(state, { type: "message.routing", channelId: "c1", messageId: "m1", step: "plan" });
const handled = (state: ReceiptsState, agentId: string, status?: "done" | "failed" | "waiting_approval") =>
  applyReceiptEvent(state, {
    type: "message.handled",
    channelId: "c1",
    messageId: "m1",
    agentId,
    ...(status ? { status } : {}),
  });

describe("the agents' receipt line under a person's message", () => {
  test("nothing before any agent saw it", () => {
    expect(receiptLine(undefined)).toBeNull();
    expect(receiptLine({ routed: true, agents: [] })).toBeNull();
  });

  test("seen only: the faces and who saw it, in words", () => {
    const line = receiptLine({ routed: false, agents: [["ada", "seen"]] });
    expect(line?.faces).toEqual(["ada"]);
    expect(line?.mark).toBe("seen");
    expect(line?.words).toEqual({ key: "receipts.seenBy", agents: ["ada"] });
    expect(line?.action).toBeNull();
  });

  test("picked and answering: faces and the orbit only (the live block says it), words for screen readers", () => {
    const picked = receiptLine(routed({}).m1);
    expect(picked?.faces).toEqual(["ada"]);
    expect(picked?.mark).toBe("working");
    expect(picked?.words).toBeNull();
    expect(picked?.label).toEqual({ key: "receipts.picked", agents: ["ada"] });
    const claimed = receiptLine(
      applyReceiptEvent(routed({}), { type: "message.claimed", channelId: "c1", messageId: "m1", agentId: "ada" }).m1,
    );
    expect(claimed?.label.key).toBe("receipts.claimed");
  });

  test("answered: the faces of who answered and a check, no words", () => {
    const line = receiptLine(handled(routed({}), "ada", "done").m1);
    expect(line?.faces).toEqual(["ada"]);
    expect(line?.mark).toBe("done");
    expect(line?.words).toBeNull();
    expect(line?.label.key).toBe("receipts.handled");
  });

  test("waiting for an approval says so", () => {
    const line = receiptLine(handled(routed({}), "ada", "waiting_approval").m1);
    expect(line?.mark).toBe("waiting");
    expect(line?.words?.key).toBe("receipts.waiting");
  });

  test("a failure is the danger tone with Retry", () => {
    const line = receiptLine(handled(routed({}), "ada", "failed").m1);
    expect(line?.words).toEqual({ key: "receipts.failed", agents: ["ada"] });
    expect(line?.action).toBe("retry");
    expect(line?.alert).toBe(true);
  });

  test("routed to nobody: no faces, 'No agent will answer'", () => {
    const line = receiptLine(routed({}, { pickedBy: [] }).m1);
    expect(line?.faces).toEqual([]);
    expect(line?.words?.key).toBe("receipts.nobody");
    expect(line?.action).toBeNull();
  });

  test("past the workspace's platform AI nobody is asked: to mention an agent, nothing to tap", () => {
    const line = receiptLine(routed({}, { seenBy: [], pickedBy: [], reason: "platform_cap" }).m1);
    expect(line).toMatchObject({ faces: [], mark: "none", words: { key: "receipts.platformCap" }, action: null });
  });

  test("nothing could pick: 'without an @', muted, and a tap opens the agents it reached, also after a reload", () => {
    const live = routed({}, { pickedBy: [], reason: "mention_needed" }).m1;
    const line = receiptLine(live);
    expect(line?.words).toEqual({ key: "receipts.mentionNeeded", agents: [] });
    expect(line?.alert).toBe(false);
    expect(line?.action).toBeNull();
    expect(receiptRows(live)).toHaveLength(2);
    const listed = {
      ...message({ id: "m1" }),
      receipts: { seenBy: ["ada", "theo"], pickedBy: [], handled: [], reason: "mention_needed" as const },
    };
    expect(receiptLine(seedReceipt({}, listed).m1)?.words?.key).toBe("receipts.mentionNeeded");
  });

  test("the author's own plan picking: the clock and 'Picking who answers', until the decision", () => {
    const seeded = seedReceipt({}, message({ id: "m1" }));
    const line = receiptLine(picking(seeded).m1);
    expect(line).toMatchObject({ faces: [], mark: "picking", action: null, alert: false });
    expect(line?.words).toEqual({ key: "receipts.picking", agents: [] });
    expect(receiptRows(picking(seeded).m1)).toEqual([]);
    const decided = routed(picking(seeded), { decidedBy: { step: "plan", brand: "claude", ownerId: "u1" } });
    expect(receiptLine(decided.m1)?.mark).toBe("working");
    // A late `message.routing` doesn't bring it back.
    expect(receiptLine(picking(decided).m1)?.mark).toBe("working");
  });

  test("the sheet's last line: who picked the agents, with its mark; nothing for nobody or a decision from before", async () => {
    const en = await translator("en");
    const names = {
      meId: "u1",
      agent: (id: string) => (id === "ada" ? "Ada" : "Theo"),
      person: (id: string) => (id === "u2" ? "Walter" : "?"),
      model: (id: string) => (id === "claude-haiku-5-5" ? "Claude Haiku 5.5" : null),
    };
    const by = (decidedBy: DecidedBy, pickedBy = ["ada"]) =>
      deciderOf(en, receiptView(routed({}, { pickedBy, decidedBy }).m1), names);
    expect(by({ step: "jev" })).toEqual({ mark: { logo: "typesafe" }, text: "Picked by Jev" });
    expect(by({ step: "model", model: "claude-haiku-5-5", provider: "anthropic" })).toEqual({
      mark: { logo: "anthropic" },
      text: "Picked by Claude Haiku 5.5",
    });
    expect(by({ step: "model", model: "gpt-9", provider: "openai" })).toBeNull();
    expect(by({ step: "plan", brand: "claude", ownerId: "u1" })?.text).toBe("Picked by your Claude plan");
    expect(by({ step: "plan", brand: "chatgpt", ownerId: "u2" })).toEqual({
      mark: { logo: "openai" },
      text: "Picked by Walter's ChatGPT plan",
    });
    expect(by({ step: "rule", rule: "only_agent" })).toEqual({
      mark: { rule: "only_agent" },
      text: "Only Ada answers here without a mention",
    });
    expect(by({ step: "jev" }, [])).toBeNull();
    expect(deciderOf(en, receiptView(routed({}).m1), names)).toBeNull();
    const pt = await translator("pt-BR");
    const reply = receiptView(routed({}, { decidedBy: { step: "rule", rule: "reply" } }).m1);
    expect(deciderOf(pt, reply, names)?.text).toBe("Uma resposta para a Ada");
  });

  test("no AI: the receipt's words and Connect, even when nobody was asked", () => {
    const line = receiptLine(routed({}, { seenBy: [], pickedBy: [], reason: "no_ai" }).m1);
    expect(line?.words?.key).toBe("noAi.receipt");
    expect(line?.action).toBe("connect");
    const agent = receiptLine(
      applyReceiptEvent(routed({}), {
        type: "message.handled",
        channelId: "c1",
        messageId: "m1",
        agentId: "ada",
        reason: "no_ai",
      }).m1,
    );
    expect(agent?.faces).toEqual(["ada"]);
    expect(agent?.action).toBe("connect");
  });

  test("at most three faces, and how many more", () => {
    const many = { routed: false, agents: ["a", "b", "c", "d", "e"].map((id) => [id, "seen"] as [string, "seen"]) };
    const line = receiptLine(many);
    expect(line?.faces).toEqual(["a", "b", "c"]);
    expect(line?.more).toBe(2);
  });

  test("a message that went into a task gives way to the steer line, unless there is something to tap", () => {
    const answering = receiptLine(routed({}).m1);
    expect(receiptShows(answering, false)).toBe(true);
    expect(receiptShows(answering, true)).toBe(false);
    expect(receiptShows(receiptLine(handled(routed({}), "ada", "failed").m1), true)).toBe(true);
    expect(receiptShows(null, false)).toBe(false);
  });

  test("the sheet: each agent with its phase; one the message only names says so", () => {
    const asked = {
      ...message({ id: "m1", mentionedAgentIds: ["theo"] }),
      receipts: { seenBy: ["ada", "theo"], pickedBy: ["ada"], handled: [], referenced: ["theo"] },
    };
    const state = seedReceipt({}, asked);
    expect(receiptRows(state.m1)).toEqual([
      { agentId: "ada", phase: "picked" },
      { agentId: "theo", phase: "referenced" },
    ]);
    expect(phaseKey("referenced")).toBe("receipts.status.referenced");
    expect(phaseKey("no_ai")).toBe("noAi.chip");
    expect(phaseKey("claimed")).toBe("receipts.status.claimed");
  });

  test("seeded from the list: a person's message starts its receipt, an agent's doesn't", () => {
    const listed = {
      ...message({ id: "m1" }),
      receipts: { seenBy: ["ada"], pickedBy: [], handled: [{ agentId: "ada", status: "done" as const }] },
    };
    const seeded = seedReceipt({}, listed);
    expect(receiptLine(seeded.m1)?.mark).toBe("done");
    const agent = seedReceipt({}, message({ id: "m2", author: { type: "agent", id: "ada" } }));
    expect(agent.m2).toBeUndefined();
  });
});

describe("which message carries the line", () => {
  test("the latest person's message the server has, skipping agents, ones still sending and event lines", () => {
    const list = [
      message({ id: "a" }),
      message({ id: "b", author: { type: "person", id: "u2" } }),
      message({ id: "c", author: { type: "agent", id: "ada" } }),
      message({ id: "d", local: "pending" }),
    ];
    expect(receiptMessageId(list)).toBe("b");
    expect(receiptMessageId([message({ id: "x", author: { type: "agent", id: "ada" } })])).toBeNull();
    expect(receiptMessageId([])).toBeNull();
  });
});

describe("the no-AI banner above the box", () => {
  const status = (any: boolean, states: Record<string, "ready" | "no_ai" | "waiting"> = {}): AiStatus => ({
    any,
    agents: Object.entries(states).map(([agentId, state]) => ({ agentId, state })),
  });
  const where = (over: Partial<{ agentIds: string[]; dmAgentId: string | null; cardShown: boolean }> = {}) => ({
    agentIds: ["ada", "theo"],
    dmAgentId: null,
    cardShown: false,
    ...over,
  });

  test("nothing while the status loads, or with an AI somewhere", () => {
    expect(noAiBanner(undefined, where())).toBeNull();
    expect(noAiBanner(status(true), where())).toBeNull();
  });

  test("a workspace without any AI, in a conversation with agents", () => {
    expect(noAiBanner(status(false), where())).toEqual({ kind: "org" });
    expect(noAiBanner(status(false), where({ agentIds: ["ada"] }))).toEqual({ kind: "org", agentId: "ada" });
    expect(noAiBanner(status(false), where({ agentIds: [] }))).toBeNull();
  });

  test("'ask in the chat' only where Jev reads the message", () => {
    const routing = (by: "jev" | "rules"): AiStatus => ({
      ...status(false),
      routing: { by, mine: by, model: null, noSmallModel: null },
    });
    expect(noAiBanner(routing("jev"), where())).toEqual({ kind: "org", askInChat: true });
    expect(noAiBanner(routing("rules"), where())).toEqual({ kind: "org" });
  });

  test("an agent's DM: only that agent's state counts", () => {
    expect(noAiBanner(status(true, { ada: "no_ai" }), where({ dmAgentId: "ada" }))).toEqual({
      kind: "agent",
      agentId: "ada",
    });
    expect(noAiBanner(status(false, { ada: "waiting" }), where({ dmAgentId: "ada" }))).toBeNull();
    expect(noAiBanner(status(false, { ada: "ready" }), where({ dmAgentId: "ada" }))).toBeNull();
  });

  test("not right under the agent's own no-AI card", () => {
    expect(noAiBanner(status(false), where({ cardShown: true }))).toBeNull();
    const card = message({ id: "n", author: { type: "agent", id: "ada" }, meta: { noAi: { agentId: "ada" } } });
    expect(endsOnNoAiCard([message({ id: "m" }), card])).toBe(true);
    expect(endsOnNoAiCard([card, message({ id: "m" })])).toBe(false);
    expect(endsOnNoAiCard([])).toBe(false);
  });
});
