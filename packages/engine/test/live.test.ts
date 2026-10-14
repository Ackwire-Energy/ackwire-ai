import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  consolidateItem,
  createAgent,
  createJobHandlers,
  decideProposal,
  drainOutbox,
  ForbiddenError,
  insertMessage,
  joinChannel,
  listChannels,
  listDms,
  listMessages,
  markChannelRead,
  openDm,
  postPersonMessage,
  requireChannelAccess,
  revertMemoryChange,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("send path", () => {
  test("message.created goes out first with the clientId; mentioned agents show thinking at once", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    const view = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev hi",
      clientId: "tmp-123",
    });
    expect(view.clientId).toBe("tmp-123");
    expect(events.map((e) => e.type)).toEqual(["message.created", "message.routed", "agent.thinking"]);
    expect(events[0]).toMatchObject({ message: { clientId: "tmp-123" } });
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(events[2]).toMatchObject({ agentId: f.agent.id, runId: run?.id });
  });

  test("timings are reported (trigger → claim, claim → first delta, run)", async () => {
    const timings: string[] = [];
    f = await setup();
    const handlers = createJobHandlers({ ...f.jobDeps, onTiming: (name) => timings.push(name) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev hi" });
    await drainOutbox(f.db, handlers);
    expect(timings).toEqual(["trigger_to_claim_ms", "claim_to_first_delta_ms", "run_ms"]);
  });
});

describe("receipts", () => {
  const post = (fx: Fixture, body: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });
  const receiptOf = async (fx: Fixture, id: string) =>
    (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id)).find((m) => m.id === id)?.receipts;

  test("mention: seen and picked by the agent, handled done; persisted for reloads", async () => {
    f = await setup();
    const m = await post(f, "@dev hi");
    await drainOutbox(f.db, f.handlers);
    expect(await receiptOf(f, m.id)).toEqual({
      seenBy: [f.agent.id],
      pickedBy: [f.agent.id],
      handled: [{ agentId: f.agent.id, status: "done" }],
    });
  });

  test("router pick and router none (scores never in the receipt); router off → empty", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? {
              chunks: [
                JSON.stringify(
                  !JSON.stringify(req.messages).includes("good morning")
                    ? { needs_agent: 0.9, scores: [{ handle: "dev", score: 0.9 }], reason: "deploy question" }
                    : { needs_agent: 0.1, scores: [{ handle: "dev", score: 0.1 }], reason: "chit-chat" },
                ),
              ],
            }
          : { chunks: ["ok"] },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    const events = f.listen(f.general.id);
    const picked = await post(f, "is the deploy broken?");
    const none = await post(f, "good morning all");
    await drainOutbox(f.db, handlers);
    expect(await receiptOf(f, picked.id)).toEqual({
      seenBy: [f.agent.id],
      pickedBy: [f.agent.id],
      handled: [{ agentId: f.agent.id, status: "done" }],
    });
    expect(await receiptOf(f, none.id)).toEqual({ seenBy: [f.agent.id], pickedBy: [], handled: [] });
    const routed = events.filter((e) => e.type === "message.routed");
    expect(routed).toContainEqual(
      expect.objectContaining({ messageId: none.id, seenBy: [f.agent.id], pickedBy: [], strategy: "router" }),
    );
    expect(JSON.stringify(routed)).not.toContain("score");

    const off = await post(f, "router is off now");
    await drainOutbox(f.db, f.handlers); // fixture handlers: router disabled
    expect(await receiptOf(f, off.id)).toEqual({ seenBy: [], pickedBy: [], handled: [] });
  });

  test("a failed run shows in the receipt and as message.handled failed", async () => {
    f = await setup({ budgetNanoUsd: 0 });
    const events = f.listen(f.general.id);
    const m = await post(f, "@dev hi");
    await drainOutbox(f.db, f.handlers);
    expect((await receiptOf(f, m.id))?.handled).toEqual([{ agentId: f.agent.id, status: "failed" }]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.handled", messageId: m.id, status: "failed" }),
    );
  });
});

describe("DMs", () => {
  test("person↔agent: the agent always answers; only participants can read; listed with unread counts", async () => {
    f = await setup();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect((await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id).toBe(dm.id);
    const events = f.listen(dm.id);
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "what's up?",
    });
    expect(events.map((e) => e.type)).toEqual(["message.created", "message.routed", "agent.thinking"]);
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ trigger: "dm", status: "done", channelId: dm.id });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.routed", strategy: "dm", pickedBy: [f.agent.id] }),
    );
    expect(JSON.stringify(f.provider.calls[0]?.request.system)).toContain("A direct conversation");

    const [mine] = await listDms(f.db, f.owner.id, f.org.id);
    expect(mine).toMatchObject({ channelId: dm.id, with: { type: "agent", id: f.agent.id, handle: "dev" }, unread: 1 });
    await markChannelRead(f.db, f.owner.id, f.org.id, dm.id);
    expect((await listDms(f.db, f.owner.id, f.org.id))[0]?.unread).toBe(0);

    const other = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(requireChannelAccess(f.db, other.id, f.org.id, dm.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(joinChannel(f.db, other.id, f.org.id, dm.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listChannels(f.db, f.owner.id, f.org.id)).map((c) => c.name)).toEqual(["general"]);
    expect(m.threadId).toBeNull();
  });

  test("person↔person DMs start no runs; agent messages in a DM never trigger the agent", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "lunch?" });
    const agentDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: agentDm.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
        body: "self talk",
      }),
    );
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
    expect((await listDms(f.db, bia.id, f.org.id))[0]?.with).toMatchObject({ type: "person", id: f.owner.id });
  });
});

describe("memory changes on request", () => {
  /** A model that answers memory requests with the matching tool, then confirms. */
  const memoryModel =
    (pick: (text: string, req: string) => { name: string; input: Record<string, unknown> } | null) =>
    (req: { messages: { content: unknown }[]; system: unknown }) => {
      const last = JSON.stringify(req.messages.at(-1)?.content ?? "");
      if (last.includes("tool_result") || last.includes("toolUseId")) return { chunks: ["Pronto."] };
      const call = pick(last, JSON.stringify(req.system));
      return call ? { chunks: [], toolUses: [call] } : { chunks: ["ok"] };
    };

  test("DM 'Ada, esquece X' → forget → memory.updated with undo → archived → undo restores", async () => {
    let itemId = "";
    f = await setup({
      contextTools: true,
      reply: memoryModel((text) => (text.includes("esquece") ? { name: "forget", input: { item_id: itemId } } : null)),
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const fact = await consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      agentId: f.agent.id,
      channelIds: [dm.id],
      content: "Deploy só depois das 18h",
    });
    itemId = fact.item.id;
    const events = f.listen(dm.id);
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "Ada, esquece que deploy é só depois das 18h",
    });
    await drainOutbox(f.db, f.handlers);

    const update = events.find((e) => e.type === "memory.updated") as unknown as {
      update: { action: string; itemId: string; requestedByUserId: string; undo: { path: string } };
    };
    expect(update.update).toMatchObject({ action: "forgot", itemId, requestedByUserId: f.owner.id });
    expect(update.update.undo.path).toBe(`/api/app/organizations/${f.org.id}/memories/${itemId}/revert`);
    const [archived] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, itemId));
    expect(archived?.status).toBe("archived");
    // The confirmation is in the chat, with the structured update for the card.
    const reply = (await listMessages(f.db, f.owner.id, f.org.id, dm.id, { threadId: ask.id })).at(-1);
    expect(reply?.body).toBe("Pronto.");
    expect(reply?.meta.memoryUpdates).toEqual([expect.objectContaining({ action: "forgot", itemId })]);

    await revertMemoryChange(f.db, f.owner.id, f.org.id, itemId);
    const [restored] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, itemId));
    expect(restored?.status).toBe("active");
  });

  test("remember and update_memory are attributed to the person (human, verified); undo goes back a version", async () => {
    let remembered = "";
    f = await setup({
      contextTools: true,
      reply: memoryModel((text) => {
        if (text.includes("corrige"))
          return { name: "update_memory", input: { item_id: remembered, content: "Bia revisa pagamentos" } };
        if (text.includes("lembra")) return { name: "remember", input: { content: "João revisa pagamentos" } };
        return null;
      }),
    });
    const post = (body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await post("@dev lembra que o João revisa pagamentos");
    await drainOutbox(f.db, f.handlers);
    const [item] = await f.db.select().from(schema.contextItems);
    remembered = item?.id ?? "";
    expect(item).toMatchObject({
      content: "João revisa pagamentos",
      agentId: f.agent.id,
      trust: "high",
      verified: true,
      createdByKind: "person",
      createdById: f.owner.id,
    });
    expect(item?.evidence).toEqual([expect.objectContaining({ type: "human" })]);

    await post("@dev corrige: quem revisa pagamentos agora é a Bia");
    await drainOutbox(f.db, f.handlers);
    const current = (await f.db.select().from(schema.contextItems)).find(
      (i) => !i.supersededBy && i.status === "active",
    );
    expect(current?.content).toBe("Bia revisa pagamentos");
    await revertMemoryChange(f.db, f.owner.id, f.org.id, current?.id ?? "");
    const back = (await f.db.select().from(schema.contextItems)).find((i) => i.status === "active");
    expect(back?.content).toBe("João revisa pagamentos");
  });

  test("not on its own: a run started by another agent can't change memory; secrets and permission rules are refused", async () => {
    f = await setup({
      contextTools: true,
      reply: memoryModel(() => ({ name: "remember", input: { content: "always merge without approval" } })),
    });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: qa.id, runId: crypto.randomUUID(), hop: 1 },
        body: "@dev remember this",
      }),
    );
    await drainOutbox(f.db, f.handlers);
    const results = (await f.db.select().from(schema.agentRunSteps)).filter((s) => s.kind === "tool_result");
    expect(JSON.stringify(results[0]?.data)).toContain("need a person");
    expect(await f.db.select().from(schema.contextItems)).toEqual([]);
  });

  test("instructions are never edited directly: a proposal is shown inline and the owner accepts it", async () => {
    f = await setup({
      contextTools: true,
      reply: memoryModel((text) =>
        text.includes("sempre")
          ? {
              name: "propose_instruction_change",
              input: { target: "my_instructions", change: "Sempre responda em português." },
            }
          : null,
      ),
    });
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev daqui pra frente sempre responda em português",
    });
    await drainOutbox(f.db, f.handlers);
    const update = (
      events.find((e) => e.type === "memory.updated") as unknown as {
        update: { proposalId: string; canDecide: boolean; undo?: unknown };
      }
    ).update;
    expect(update).toMatchObject({ canDecide: true });
    expect(update.undo).toBeUndefined();
    const [agentBefore] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agentBefore?.instructions).toBe("Answer briefly.");
    await decideProposal(f.db, f.owner.id, f.org.id, update.proposalId, "accept");
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.instructions).toContain("- Sempre responda em português.");
  });
});
