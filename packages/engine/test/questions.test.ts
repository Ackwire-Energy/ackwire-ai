import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  answerQuestion,
  ConflictError,
  drainOutbox,
  expireQuestions,
  listMessages,
  openDm,
  postPersonMessage,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** Asks which environment for "deploy it"; answers simple requests directly. */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: [`Ok: ${/answered: ([a-z]+)/.exec(last)?.[1] ?? "no answer"}`] };
  if (last.includes("deploy it"))
    return {
      chunks: [],
      toolUses: [{ name: "ask_user", input: { question: "Qual ambiente?", choices: ["staging", "production"] } }],
    };
  return { chunks: ["Feito."] };
};

const post = (body: string, threadId?: string, channelId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId ?? f.general.id, {
    body,
    threadId,
  });

const runs = () => f.db.select().from(schema.agentRuns);
const questions = () => f.db.select().from(schema.agentQuestions);

describe("ask_user", () => {
  test("an ambiguous request asks; the answer from the card resumes the run with it", async () => {
    f = await setup({ askUser: true, reply });
    const events = f.listen(f.general.id);
    const ask = await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    expect(run?.status).toBe("waiting_input");
    const [q] = await questions();
    expect(q).toMatchObject({ text: "Qual ambiente?", choices: ["staging", "production"], status: "open" });
    expect(q?.threadId).toBe(ask.id);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    const card = thread.find((m) => m.id === q?.messageId);
    expect(card?.meta.questionId).toBe(q?.id);
    expect(card?.meta.question).toMatchObject({ id: q?.id, messageId: q?.messageId, status: "open", answer: null });
    await Bun.sleep(5);
    const asked = events.find((e) => e.type === "question.asked") as unknown as {
      threadId: string;
      question: { id: string; choices: string[] };
    };
    expect(asked.threadId).toBe(ask.id);
    expect(asked.question.choices).toEqual(["staging", "production"]);

    await expect(
      answerQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "", { choice: "dev" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const answered = await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", {
      choice: "staging",
    });
    expect(answered).toMatchObject({ status: "answered", answer: "staging", answeredByUserId: f.owner.id });
    await expect(
      answerQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "", { text: "again" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person answered: staging");
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    expect(after.at(-1)?.body).toBe("Ok: staging");
    expect(after.find((m) => m.id === q?.messageId)?.meta.question).toMatchObject({ status: "answered" });
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "question.answered")).toBe(true);
  });

  test("the next reply in the thread answers it, without starting another run", async () => {
    f = await setup({ askUser: true, reply });
    const ask = await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const answer = await post("production, por favor", ask.id);
    expect(answer.meta.answersQuestionId).toBe((await questions())[0]?.id);
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    expect((await questions())[0]).toMatchObject({ status: "answered", answer: "production, por favor" });
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    expect(thread.at(-1)?.body).toBe("Ok: production");
  });

  test("in a DM the question and the answer stay in the main timeline", async () => {
    f = await setup({ askUser: true, reply });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post("deploy it", undefined, dm.id);
    await drainOutbox(f.db, f.handlers);
    expect((await questions())[0]?.threadId).toBeNull();
    await post("staging", undefined, dm.id);
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]); // the answer started no new DM run
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, dm.id);
    expect(timeline.map((m) => m.body)).toEqual(["deploy it", "Qual ambiente?", "staging", "Ok: staging"]);
    expect(timeline.every((m) => m.threadId === null)).toBe(true);
  });

  test("a simple request is answered directly; the prompt tells when to ask", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev what's 2+2?");
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect(await questions()).toEqual([]);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(request.tools?.map((t) => t.name)).toContain("ask_user");
    expect(systemText(request.system)).toContain("don't ask about simple requests");
    expect(systemText(request.system)).toContain("ambiguous after you have looked with your tools");
  });

  test("with no answer in 24 hours the run goes on and the model is told", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub })).toBe(0);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 25 * 3600_000))).toBe(1);
    await drainOutbox(f.db, f.handlers);
    const [run] = await runs();
    expect(run?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("No one answered within 24 hours");
    const [q] = await f.db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.runId, run?.id ?? ""));
    expect(q?.status).toBe("expired");
  });
});
