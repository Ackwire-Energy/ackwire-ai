import { afterEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  buildRunContext,
  catchUpText,
  createAgent,
  drainOutbox,
  insertMessage,
  listChannels,
  listDms,
  listMessages,
  markChannelRead,
  openDm,
  PLACE_KEPT_MS,
  postPersonMessage,
  THREAD_ASSESS_DELAY_MS,
} from "../src";
import { runReadOutsideById } from "../src/outside";
import { type Fixture, setup } from "./fixtures";

/**
 * A streamed reply keeps the place where its first words showed (ADR 0010, `agent.delta.shownAt`): its message is
 * posted there, so what people sent while it wrote stays below it, as the apps drew it live, whatever text it ends
 * with. What asks for what is new since a moment (unread, a catch-up) still reads it as new (`landedAfterSql`).
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Past `WORKING_TEXT_MAX`: it shows live as it streams, not only at the turn's end. */
const LONG = "O deploy de ontem trocou a chave do cache e o login passou a cair depois do refresh. ".repeat(4);

const postIn = (channelId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });

/** The `shownAt` of each turn's live text in `channelId`, as it goes out. */
const shownAts = (channelId: string) => {
  const byTurn = new Map<number, string>();
  f.pubsub.subscribe(channelTopic(channelId), (e) => {
    const d = e as { type: string; turn?: number; shownAt?: string };
    if (d.type === "agent.delta" && d.shownAt && d.turn !== undefined) byTurn.set(d.turn, d.shownAt);
  });
  return byTurn;
};

/** Resolves once text of turn `turn` went out live in `channelId`. */
const wordsOf = (channelId: string, turn: number) =>
  new Promise<void>((resolve) =>
    f.pubsub.subscribe(channelTopic(channelId), (e) => {
      const d = e as { type: string; turn?: number };
      if (d.type === "agent.delta" && d.turn === turn) resolve();
    }),
  );

test("a streamed reply keeps the place its first words showed in: what a person sent meanwhile reads below it", async () => {
  let dmId = "";
  f = await setup({
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: [LONG, "Corrijo a chave."],
            // The person writes once its first words are on screen, while the rest is still on its way.
            hold: wordsOf(dmId, 1).then(() => Bun.sleep(5).then(() => postIn(dmId, "olha o refresh também"))),
          }
        : { chunks: ["Olhei o refresh: está certo."] },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  const shown = shownAts(dmId);
  await postIn(dmId, "por que o login cai?");
  await drainOutbox(f.db, f.handlers);

  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  expect(dm.map((m) => m.body)).toEqual([
    "por que o login cai?",
    `${LONG}Corrijo a chave.`.trim(),
    "olha o refresh também",
    "Olhei o refresh: está certo.",
  ]);
  const [, reply, meanwhile] = dm;
  // Its place is the moment its live text carried; it was posted after the person wrote (ids are UUIDv7).
  expect(reply?.createdAt).toBe(shown.get(1) as string);
  expect((reply?.id ?? "") > (meanwhile?.id ?? "")).toBe(true);
  expect(Date.parse(reply?.createdAt ?? "")).toBeLessThan(Date.parse(meanwhile?.createdAt ?? ""));
  // The next answer opened a place of its own, after what it read.
  expect(shown.get(2)).toBe(dm[3]?.createdAt as string);
});

test("a draft sent back for another try keeps its place when another text replaces it", async () => {
  let dmId = "";
  let verdicts = 0;
  f = await setup({
    // Its first answer gives up with ways left: one more try, never posted; the second is the answer.
    judge: (kind) => (kind === "follow_through" ? (++verdicts === 1 ? "untried" : "done") : undefined),
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: [`Não consegui ver os logs. ${LONG}`],
            hold: wordsOf(dmId, 1).then(() => Bun.sleep(5).then(() => postIn(dmId, "é urgente"))),
          }
        : { chunks: [call === 2 ? "Achei: a chave do cache mudou no deploy de ontem." : "Pronto."] },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  const shown = shownAts(dmId);
  await postIn(dmId, "por que o login cai?");
  await drainOutbox(f.db, f.handlers);

  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  expect(dm.some((m) => m.body.startsWith("Não consegui"))).toBe(false);
  const final = dm.find((m) => m.body.startsWith("Achei"));
  const urgent = dm.find((m) => m.body === "é urgente");
  // The live block showed the draft, then this text in its place: the message is posted there, above what came meanwhile.
  expect(shown.get(2)).toBe(shown.get(1) as string);
  expect(final?.createdAt).toBe(shown.get(1) as string);
  expect(dm.indexOf(final as (typeof dm)[number])).toBeLessThan(dm.indexOf(urgent as (typeof dm)[number]));
});

test("told to ask, the question card it posts keeps the place of the reply it stands for", async () => {
  const question = `Para configurar o alerta preciso do token do Sentry: ${"você gera em Settings, Auth Tokens, com escopo de projeto. ".repeat(3)}Pode me mandar o token por aqui, assim que tiver ele em mãos?`;
  expect(question.length).toBeGreaterThan(280);
  expect(question.length).toBeLessThanOrEqual(300);
  let dmId = "";
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "ask" : undefined),
    reply: (_request, call) =>
      call === 1
        ? { chunks: ["Assim que tiver o token do Sentry, configuro o alerta."] }
        : {
            chunks: [question],
            hold: wordsOf(dmId, 2).then(() => Bun.sleep(5).then(() => postIn(dmId, "vou procurar"))),
          },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  const shown = shownAts(dmId);
  await postIn(dmId, "configura o alerta do Sentry");
  await drainOutbox(f.db, f.handlers);

  const [card] = await f.db.select().from(schema.agentQuestions);
  expect(card?.text).toBe(question);
  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  const cardMessage = dm.find((m) => m.id === card?.messageId);
  const meanwhile = dm.find((m) => m.body === "vou procurar");
  expect(cardMessage?.createdAt).toBe(shown.get(2) as string);
  expect(dm.indexOf(cardMessage as (typeof dm)[number])).toBeLessThan(dm.indexOf(meanwhile as (typeof dm)[number]));
});

test("posted after someone read, in a place before their read: unread for them, and a catch-up reads it", async () => {
  f = await setup();
  const agentSays = (channelId: string, body: string, createdAt?: Date) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body,
      ...(createdAt ? { createdAt } : {}),
    });
  const dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  for (const channelId of [f.general.id, dmId]) await agentSays(channelId, "Lido antes.");
  await Bun.sleep(5);
  const readAt = new Date();
  for (const channelId of [f.general.id, dmId]) await markChannelRead(f.db, f.owner.id, f.org.id, channelId, readAt);
  await Bun.sleep(5);
  for (const channelId of [f.general.id, dmId]) {
    // Written while they read, posted after: its place is before their read.
    await agentSays(channelId, "O deploy de ontem trocou a chave.", new Date(readAt.getTime() - 30_000));
    // Never placed this far back: the executor posts such a reply at the end.
    await agentSays(channelId, "Bem antigo.", new Date(readAt.getTime() - PLACE_KEPT_MS - 60_000));
  }
  const general = (await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === f.general.id);
  expect(general?.unreadCount).toBe(1);
  const dm = (await listDms(f.db, f.owner.id, f.org.id)).find((d) => d.channelId === dmId);
  expect(dm?.unread).toBe(1);

  // A run asked at `trigger`, back from a wait: a reply that landed since, placed before its trigger, is news to it.
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "e o refresh?",
  });
  await Bun.sleep(5);
  await agentSays(f.general.id, "Já olhei o refresh.", new Date(trigger.createdAt.getTime() - 10_000));
  const text = await catchUpText(
    f.db,
    {
      orgId: f.org.id,
      agentId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      pendingMessageIds: [],
    },
    trigger,
    { since: Date.now() - 20 * 60_000, why: "plan", mayPass: true },
  );
  expect(text).toContain("Já olhei o refresh.");
  expect(text).not.toContain("Lido antes.");
});

test("asked by a reply another agent wrote over a while, a run reads what was sent while it was written", async () => {
  f = await setup();
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", role: "Testes", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const qaSays = (body: string, meta?: Record<string, unknown>, createdAt?: Date) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: qa.id, runId: null, hop: 1, stretchId: null },
      body,
      ...(meta ? { meta } : {}),
      ...(createdAt ? { createdAt } : {}),
    });
  // QA's words showed 30 s ago; a person and a relayed e-mail came in as it wrote, then its reply took that place.
  const shownAt = new Date(Date.now() - 30_000);
  await postIn(f.general.id, "o deploy já foi revertido");
  await qaSays("O e-mail do cliente diz que voltou a cair.", { readOutside: true });
  const ask = await qaSays("@dev olha o deploy de ontem", undefined, shownAt);
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "mention",
      hop: 2,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  await Bun.sleep(5);
  await postIn(f.general.id, "alguém viu?");

  const read = JSON.stringify((await buildRunContext(f.db, run, f.agent, { maxMessages: 30 })).messages);
  expect(read).toContain("o deploy já foi revertido");
  expect(read).toContain("O e-mail do cliente");
  expect(read).toContain("olha o deploy de ontem");
  // Sent after it was asked: it comes to the run as it works, not as what was there.
  expect(read).not.toContain("alguém viu?");
  // What it read relays outside content, so what it posts says so (ADR 0117).
  expect(await runReadOutsideById(f.db, f.org.id, run.id)).toBe(true);
});

test("stopped to read a message sent to it, the answer it writes next goes below that message", async () => {
  let dmId = "";
  f = await setup({
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: [LONG, "isto nunca chega"],
            // "Parar e mandar" once its first words are on screen: the call is cut, the message read at once.
            hold: wordsOf(dmId, 1).then(() =>
              postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dmId, {
                body: "na verdade, olha o refresh",
                steer: "now",
              }),
            ),
          }
        : { chunks: ["Certo, olhei o refresh: a chave expira antes do token."] },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  await postIn(dmId, "por que o login cai?");
  await drainOutbox(f.db, f.handlers);

  expect(f.provider.calls).toHaveLength(2);
  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  expect(dm.map((m) => m.body)).toEqual([
    "por que o login cai?",
    "na verdade, olha o refresh",
    "Certo, olhei o refresh: a chave expira antes do token.",
  ]);
});

test("a reply that kept its place above one posted before it still gets its thread assessed", async () => {
  const isAssess = (system: Parameters<typeof systemText>[0]) =>
    systemText(system).startsWith("You read a conversation thread");
  f = await setup({
    reply: (request) => ({
      chunks: [isAssess(request.system) ? JSON.stringify({ title: "Login caindo no refresh", resolved: true }) : "ok"],
    }),
  });
  const assessed = () => f.provider.calls.filter((c) => isAssess(c.request.system));
  const later = () => drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + THREAD_ASSESS_DELAY_MS + 60_000) });
  const root = await postIn(f.general.id, "o login cai depois do refresh");
  const shownAt = new Date();
  await Bun.sleep(5);
  // Sent in the thread while the agent wrote its answer; assessed before the answer landed.
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "acontece no iOS também",
    threadId: root.id,
  });
  await later();
  const before = assessed().length;
  // The answer lands in the place where its words first showed, above that message.
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: root.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "Corrigido: a chave do cache expirava antes do token.",
    createdAt: shownAt,
  });
  await later();
  expect(assessed()).toHaveLength(before + 1);
  expect(JSON.stringify(assessed().at(-1)?.request.messages)).toContain("Corrigido");
});
