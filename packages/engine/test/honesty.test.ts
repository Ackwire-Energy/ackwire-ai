import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import { cancelRun, drainOutbox, postPersonMessage } from "../src";
import { decideTurnEnd, UNBACKED_NUDGE } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * An agent never claims a result it didn't produce (ADR 0167): a reply saying something was made, sent or done that
 * no call did is not posted, and the run goes on once to do it or say plainly it can't.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  return last ? textOf(last.content) : "";
};

test("a reply claiming an image no call made is not posted; the run is told to do it or say it can't", async () => {
  let judged = 0;
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? (judged++ === 0 ? "unbacked" : "done") : undefined),
    reply: (_request, call) => ({
      chunks: [
        call === 1
          ? "Pronto! Aqui está a imagem do hambúrguer 🍔"
          : "Não consigo gerar imagens: não tenho uma ferramenta de imagem aqui.",
      ],
    }),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz uma imagem de um hambúrguer",
  });
  await drainOutbox(f.db, f.handlers);

  expect(f.provider.calls.length).toBe(2);
  expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toBe(UNBACKED_NUDGE);
  const posted = (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice,
  );
  expect(posted.map((m) => m.body)).toEqual(["Não consigo gerar imagens: não tenho uma ferramenta de imagem aqui."]);
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.filter((s) => s.data.nudged === "unbacked").length).toBe(1);
});

test("the nudge comes once: a claim judged again past the cap ends the run as it is", async () => {
  const turn = (count: number) =>
    decideTurnEnd({
      state: { count },
      kind: "conversation",
      executed: 0,
      bound: null,
      quiet: false,
      decided: null,
      unanswered: false,
      unreached: "",
      judged: "Feito, enviei o e-mail.",
      mission: false,
      wakesLater: async () => false,
      verdict: async () => "unbacked",
    });
  expect(await turn(0)).toMatchObject({ outcome: "continue", rule: "unbacked", nudge: UNBACKED_NUDGE });
  expect(await turn(2)).toMatchObject({ outcome: "done", rule: "unbacked_cap" });
});

const agentBodies = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent" && !m.meta.notice)
    .map((m) => m.body);

const CLAIM = "Pronto! Aqui está a imagem do hambúrguer 🍔";

test("a held reply is never posted later as the closing line of a turn that writes nothing", async () => {
  let judged = 0;
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? (judged++ === 0 ? "unbacked" : "done") : undefined),
    reply: (_request, call) => ({ chunks: call === 1 ? [CLAIM] : call === 2 ? [] : ["Não consigo gerar imagens."] }),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz uma imagem de um hambúrguer",
  });
  await drainOutbox(f.db, f.handlers);
  const bodies = await agentBodies(f);
  expect(bodies.join("\n")).not.toContain("hambúrguer");
  expect(bodies).toEqual(["Não consigo gerar imagens."]);
});

test("a held reply is never shown in what a stopped run wrote", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "unbacked" : undefined),
    reply: (_request, call) => {
      if (call === 2) {
        // Stopped while it writes again: its stream goes on only once the stop is in.
        const stopped = f.db
          .select()
          .from(schema.agentRuns)
          .then(([run]) => run && cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id));
        return { chunks: ["Na verdade, ", "não consigo."], hold: stopped };
      }
      return { chunks: [CLAIM] };
    },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz uma imagem de um hambúrguer",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("canceled");
  const stopped = (await f.db.select().from(schema.messages)).find((m) => m.meta.canceled);
  expect(stopped).toBeDefined();
  expect(stopped?.body).not.toContain("Pronto!");
  expect(JSON.stringify(stopped?.meta.canceled)).not.toContain("Pronto!");
});
