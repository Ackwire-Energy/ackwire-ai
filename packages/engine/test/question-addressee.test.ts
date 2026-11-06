import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  answerQuestion,
  dismissQuestion,
  drainOutbox,
  ForbiddenError,
  listThreads,
  postPersonMessage,
  workViews,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "I need a person's answer before I go on: this decides what I change next.";

/** "@dev ask: <json>": the agent calls `ask_user` with that input, then ends its turn. */
const reply = (req: ModelRequest) => {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  const input = /ask: (\{.*?\})(?:\\n|")/.exec(last.replaceAll('\\"', '"'))?.[1];
  return input
    ? { chunks: [], toolUses: [{ name: "ask_user", input: { why: WHY, ...JSON.parse(input) } }] }
    : { chunks: ["Feito."] };
};

const setupRoom = async () => {
  f = await setup({ askUser: true, reply });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  return { bia };
};

const say = async (userId: string, body: string, threadId?: string) => {
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, {
    body,
    threadId,
  });
  await drainOutbox(f.db, f.handlers);
  return message;
};

const ask = (input: Record<string, unknown>) => `@dev ask: ${JSON.stringify(input)}`;

const questions = () => f.db.select().from(schema.agentQuestions);
const deps = () => ({ db: f.db, pubsub: f.pubsub });

describe("a question for one person", () => {
  test("it waits on them alone: only they answer it, skip it or hear about it", async () => {
    const { bia } = await setupRoom();
    const root = await say(f.owner.id, "plano");
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "@bia" }), root.id);

    const [q] = await questions();
    expect(q).toMatchObject({ requestedForUserId: bia.id, status: "open" });
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, q?.messageId ?? ""));
    expect(card?.meta.question).toMatchObject({ requestedForUserId: bia.id });

    // The owner of the workspace is no exception.
    const id = q?.id ?? "";
    await expect(answerQuestion(deps(), f.owner.id, f.org.id, id, { text: "eu sei" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(dismissQuestion(deps(), f.owner.id, f.org.id, id)).rejects.toBeInstanceOf(ForbiddenError);

    const waiting = (await f.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_question");
    expect(waiting.map((n) => n.userId)).toEqual([bia.id]);
    const needsYou = async (userId: string) =>
      (await listThreads(f.db, userId, { orgId: f.org.id, needsYou: true })).threads.map((t) => t.id);
    expect(await needsYou(bia.id)).toEqual([root.id]);
    expect(await needsYou(f.owner.id)).toEqual([]);

    // Replying in the thread doesn't answer it either, unless it is them.
    await say(f.owner.id, "acho que foi sexta", root.id);
    expect((await questions())[0]?.status).toBe("open");
    await say(bia.id, "foi sexta", root.id);
    expect((await questions())[0]).toMatchObject({ status: "answered", answer: "foi sexta", answeredByUserId: bia.id });
  });

  test("in a channel's main timeline, their plain reply answers it", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia" }));
    await say(bia.id, "foi sexta");
    expect((await questions())[0]).toMatchObject({ status: "answered", answer: "foi sexta" });
  });

  test("they can skip it from the card", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia" }));
    const [q] = await questions();
    await dismissQuestion(deps(), bia.id, f.org.id, q?.id ?? "");
    expect((await questions())[0]).toMatchObject({ status: "dismissed", answeredByUserId: bia.id });
  });

  test("a person who can't read the conversation can't be asked there: the agent hears why", async () => {
    await setupRoom();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: caio.name }));
    await say(f.owner.id, ask({ question: "E agora?", person: "ninguem" }));
    expect(await questions()).toEqual([]);
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { content: string; isError: boolean });
    expect(results.map((r) => [r.isError, r.content])).toEqual([
      [true, expect.stringContaining("isn't in this conversation")],
      [true, expect.stringContaining('No one called "ninguem"')],
    ]);
  });

  test("a long work's view carries who it waits for", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia" }));
    const [run] = await f.db.select().from(schema.agentRuns);
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        anchorMessageId: run?.triggerMessageId ?? "",
        title: "Combinado",
        ownThread: false,
        how: "agent",
        lastUpdateAt: new Date(),
        status: "live",
      })
      .returning();
    await f.db.update(schema.agentRuns).set({ workId: work?.id });
    const view = (await workViews(f.db, f.org.id, [work?.id ?? ""])).get(work?.id ?? "");
    expect(view?.question).toMatchObject({ requestedForUserId: bia.id });
  });
});

describe("a question that doesn't say who it is for", () => {
  test("it names the person behind the run and nobody else here: it is theirs", async () => {
    const { bia } = await setupRoom();
    await say(bia.id, ask({ question: "Qual foi o combinado, Bia." }));
    expect((await questions())[0]?.requestedForUserId).toBe(bia.id);
  });

  test("it names someone else: their name alone proves nothing, it stays with the room", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Bia, qual foi o combinado?" }));
    const [q] = await questions();
    expect(q?.requestedForUserId).toBeNull();
    await answerQuestion(deps(), bia.id, f.org.id, q?.id ?? "", { text: "sexta" });
  });

  test("it names two people, or nobody: anyone here answers, as ever", async () => {
    const { bia } = await setupRoom();
    await say(bia.id, ask({ question: "Bia e ana, qual foi o combinado?" }));
    await say(f.owner.id, ask({ question: "Qual ambiente?" }));
    expect((await questions()).map((q) => q.requestedForUserId)).toEqual([null, null]);
  });

  test("the name has to be a whole word", async () => {
    const { bia } = await setupRoom();
    await say(bia.id, ask({ question: "Quem cuida da biallelic?" }));
    expect((await questions())[0]?.requestedForUserId).toBeNull();
  });
});
