import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  answerQuestion,
  createAgent,
  createChannel,
  drainOutbox,
  listWaiting,
  notify,
  postPersonMessage,
  waitingOnPerson,
  waitingOnPersonBlock,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** Dev asks which environment for "deploy it"; anything else gets a plain answer. */
const reply = (req: ModelRequest) => {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  // Only Dev asks: the conversation's history reaches every agent's request.
  if (last.includes("deploy it") && systemText(req.system ?? "").includes("You are Dev"))
    return {
      chunks: [],
      toolUses: [
        {
          name: "ask_user",
          input: { why: "The environment decides what I change next.", question: "Qual ambiente?" },
        },
      ],
    };
  return { chunks: ["Feito."] };
};

const post = (body: string, userId = f.owner.id) => postPersonMessage(deps(), userId, f.org.id, f.general.id, { body });

const systemOf = (said: string) =>
  systemText(f.provider.calls.find((c) => JSON.stringify(c.request.messages).includes(said))?.request.system ?? "");

test("an open question waits on the person it is for, and leaves the list once answered", async () => {
  f = await setup({ askUser: true, reply });
  expect(await listWaiting(deps(), f.owner.id, f.org.id)).toEqual({ items: [], count: 0 });

  await post("@dev deploy it");
  await drainOutbox(f.db, f.handlers);
  const [q] = await f.db.select().from(schema.agentQuestions);
  const waiting = await listWaiting(deps(), f.owner.id, f.org.id);
  expect(waiting.count).toBe(1);
  expect(waiting.items[0]).toMatchObject({
    kind: "agent_question",
    asker: { type: "agent", id: f.agent.id },
    question: "Qual ambiente?",
    source: { channelId: f.general.id, questionId: q?.id, messageId: q?.messageId },
  });
  expect(Date.parse(waiting.items[0]?.since ?? "")).toBeGreaterThanOrEqual(q?.createdAt.getTime() ?? Number.NaN);

  // Nobody else's list holds it.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  expect((await listWaiting(deps(), bia.id, f.org.id)).count).toBe(0);

  await answerQuestion(deps(), f.owner.id, f.org.id, q?.id ?? "", { text: "staging" });
  expect((await listWaiting(deps(), f.owner.id, f.org.id)).count).toBe(0);
});

test("oldest first, one conversation's on request, and nothing from a conversation the person can't read", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const closed = await createChannel(f.db, f.owner.id, f.org.id, { name: "cofre", visibility: "private" });
  const wait = (key: string, source: Record<string, unknown>, text: string) =>
    notify(deps(), {
      orgId: f.org.id,
      userIds: [bia.id],
      kind: "agent_question",
      groupKey: key,
      waiting: true,
      actor: { type: "agent", id: f.agent.id },
      source,
      latest: { text },
    });
  await wait("w:1", { channelId: f.general.id }, "Primeira?");
  await wait("w:2", { channelId: closed.id }, "Do cofre?");
  await wait("w:3", {}, "Sem conversa?");
  // Not waiting: in the inbox, never in this list.
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id],
    kind: "mention",
    groupKey: "m:1",
    actor: { type: "agent", id: f.agent.id },
    source: { channelId: f.general.id },
    latest: { text: "oi" },
  });

  const all = await listWaiting(deps(), bia.id, f.org.id);
  expect(all.items.map((i) => i.question)).toEqual(["Primeira?", "Sem conversa?"]);
  expect(all.count).toBe(2);
  const here = await listWaiting(deps(), bia.id, f.org.id, { channelId: f.general.id });
  expect(here.items.map((i) => i.question)).toEqual(["Primeira?"]);

  // Let into the private channel, its question shows.
  await addChannelMember(f.db, f.owner.id, f.org.id, closed.id, { userId: bia.id });
  expect((await listWaiting(deps(), bia.id, f.org.id)).items.map((i) => i.question)).toEqual([
    "Primeira?",
    "Do cofre?",
    "Sem conversa?",
  ]);
});

test("another agent reads what already waits on the person, only while something does; the asker isn't told twice", async () => {
  f = await setup({ askUser: true, reply });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "DevOps", instructions: "Keep it up.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });

  await post("@ops first hello");
  await drainOutbox(f.db, f.handlers);
  expect(systemOf("@ops first hello")).not.toContain("# Already waiting on this person");

  await post("@dev deploy it");
  await drainOutbox(f.db, f.handlers);
  // Dev's own question is under its "Your open requests": never said to it again here.
  expect(await waitingOnPerson(f.db, f.org.id, f.owner.id, f.agent.id, f.general.id)).toEqual([]);
  expect(await waitingOnPerson(f.db, f.org.id, f.owner.id, ops.id, f.general.id)).toEqual([
    { agentName: "Dev", channelId: f.general.id, question: "Qual ambiente?" },
  ]);
  // Ten older ones asked elsewhere: this conversation's still leads, inside the cap.
  for (let i = 0; i < 10; i++)
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: f.owner.id,
      kind: "agent_question",
      groupKey: `old:${i}`,
      waiting: true,
      actors: [{ type: "agent", id: f.agent.id }],
      source: {},
      latest: { text: `Antiga ${i}?` },
      createdAt: new Date(2020, 0, 1 + i),
      updatedAt: new Date(2020, 0, 1 + i),
    });
  expect((await waitingOnPerson(f.db, f.org.id, f.owner.id, ops.id, f.general.id))[0]?.question).toBe("Qual ambiente?");
  await post("@ops second hello");
  await drainOutbox(f.db, f.handlers);
  const system = systemOf("@ops second hello");
  expect(system).toContain("# Already waiting on this person");
  expect(system).toContain('- Dev, here: "Qual ambiente?"');
});

test("what was asked in another conversation is counted, never quoted", () => {
  const block = waitingOnPersonBlock(
    [
      { agentName: "Dev", channelId: "here", question: "Qual ambiente?" },
      { agentName: "Lia", channelId: "elsewhere", question: "Qual é a senha do cofre?" },
      { agentName: "Lia", channelId: null, question: "Publicar o painel?" },
    ],
    "here",
  );
  expect(block).toContain('- Dev, here: "Qual ambiente?"');
  expect(block).toContain("- 2 in other conversations");
  expect(block).not.toContain("cofre");
  expect(waitingOnPersonBlock([], "here")).toBeNull();

  // More here than the block quotes: the one left out is not said to be elsewhere.
  const many = waitingOnPersonBlock(
    Array.from({ length: 9 }, (_, i) => ({ agentName: "Dev", channelId: "here", question: `Pergunta ${i}?` })),
    "here",
  );
  expect(many).toContain('"Pergunta 7?"');
  expect(many).not.toContain('"Pergunta 8?"');
  expect(many).toContain("- more, here or in other conversations");
  expect(many).not.toMatch(/- \d+ /);
});
