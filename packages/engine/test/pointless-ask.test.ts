import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { ASKS_NOTHING, drainOutbox, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * A question card that asks the person for nothing the run needs (a status note, an optional offer) never makes the
 * run wait, in any language: `ask_user` refuses it (`ask_check` → `none`) and the agent says it in its reply, and a
 * reply read as needing a person but asking for nothing is its answer, never a nudge nor a card. The fake judge reads
 * no words: it answers by the exact text it is shown.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const CASES = {
  pt: {
    question: "Qual canal recebe o post: #geral ou #avisos?",
    note: "Não preciso de nada de você agora. Só entra se você quiser o comunicado também no Portal.",
  },
  en: {
    question: "Which channel gets the post: #general or #news?",
    note: "I don't need anything from you now. Only if you want the notice on the Portal too.",
  },
  ja: {
    question: "投稿はどのチャンネルですか：#general と #news のどちらですか？",
    note: "今はあなたから必要なものはありません。ポータルにも掲載したい場合だけ教えてください。",
  },
  de: {
    question: "Welcher Kanal bekommt den Beitrag: #general oder #news?",
    note: "Ich brauche gerade nichts von dir. Nur wenn du die Mitteilung auch im Portal willst.",
  },
} as const;
const LANGS = Object.keys(CASES) as (keyof typeof CASES)[];
const NOTES: Set<string> = new Set(Object.values(CASES).map((c) => c.note));
/** The fake `ask_check`: a note asks for nothing, anything else is a person's to answer. */
const askCheck = (state: Record<string, unknown>) => (NOTES.has(String(state.question)) ? "none" : "person");

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const WHY = "I need a person's answer before I go on: this decides what I change next.";
const DONE = "Pronto: o post das 9h está agendado.";

const runs = () => f.db.select().from(schema.agentRuns);
const questions = () => f.db.select().from(schema.agentQuestions);
const judged = (kind: string) =>
  (f.context.judge as unknown as { calls: { kind: string; state: Record<string, unknown> }[] }).calls.filter(
    (c) => c.kind === kind,
  );
const agentPosts = async () =>
  (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent" && !m.meta.notice && !m.meta.questionId)
    .map((m) => m.body);
const say = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

describe("ask_user that asks for nothing", () => {
  for (const lang of LANGS) {
    const { question, note } = CASES[lang];

    test(`${lang}: a status note is refused and goes in the reply; the run doesn't wait`, async () => {
      f = await setup({
        askUser: true,
        judge: (kind, _id, state) => (kind === "ask_check" ? askCheck(state) : undefined),
        reply: (req) =>
          lastText(req).includes("tool_result")
            ? { chunks: [DONE] }
            : { chunks: [DONE], toolUses: [{ name: "ask_user", input: { why: WHY, question: note } }] },
      });
      await say("@dev valeu");
      await drainOutbox(f.db, f.handlers);
      expect(await questions()).toHaveLength(0);
      expect((await runs()).map((r) => r.status)).toEqual(["done"]);
      expect(lastText(f.provider.calls[1]?.request as ModelRequest)).toContain(ASKS_NOTHING.slice(0, 40));
      // What it already wrote in that turn reached the judge with the question.
      const [check] = judged("ask_check");
      expect(check?.state.question).toBe(note);
      expect(check?.state.reply).toBe(DONE);
    });

    test(`${lang}: a real question is still asked and waits`, async () => {
      f = await setup({
        askUser: true,
        judge: (kind, _id, state) => (kind === "ask_check" ? askCheck(state) : undefined),
        reply: () => ({
          chunks: [],
          toolUses: [{ name: "ask_user", input: { why: WHY, question } }],
        }),
      });
      await say("@dev posta o aviso");
      await drainOutbox(f.db, f.handlers);
      expect((await questions()).map((q) => q.text)).toEqual([question]);
      expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
    });

    test(`${lang}: a reply read as needing a person but asking nothing is the answer, no nudge nor card`, async () => {
      f = await setup({
        askUser: true,
        judge: (kind, _id, state) =>
          kind === "follow_through" ? "ask" : kind === "ask_check" ? askCheck(state) : undefined,
        reply: () => ({ chunks: [note] }),
      });
      await say("@dev valeu");
      await drainOutbox(f.db, f.handlers);
      expect(f.provider.calls).toHaveLength(1);
      expect(await questions()).toHaveLength(0);
      expect(await agentPosts()).toEqual([note]);
      expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    });
  }

  test("a described need still gets its nudge, then becomes the question card", async () => {
    const { question } = CASES.de;
    f = await setup({
      askUser: true,
      judge: (kind, _id, state) =>
        kind === "follow_through" ? "ask" : kind === "ask_check" ? askCheck(state) : undefined,
      reply: () => ({ chunks: [question] }),
    });
    await say("@dev posta o aviso");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(2);
    expect((await questions()).map((q) => q.text)).toEqual([question]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
  });

  test("the judge failing posts the card (fail open)", async () => {
    const { note } = CASES.en;
    f = await setup({
      askUser: true,
      judge: (kind) => {
        if (kind === "ask_check") throw new Error("judge unavailable");
        return undefined;
      },
      reply: () => ({ chunks: [], toolUses: [{ name: "ask_user", input: { why: WHY, question: note } }] }),
    });
    await say("@dev valeu");
    await drainOutbox(f.db, f.handlers);
    expect((await questions()).map((q) => q.text)).toEqual([note]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
  });
});
