import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import { drainOutbox, openDm, runRoutineNow } from "../src";
import { type Fixture, setup } from "./fixtures";
import { channelRoutine, messagesIn, routineDeps } from "./routine-fixtures";

/** ADR 0053 §4 (amended): a routine's message is the message; hand-off only when the agent must act there. */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const seen = (req: ModelRequest) => JSON.stringify(req.messages);
const GREETING = "Bom dia! Que a sua segunda comece leve.";

test("a greeting routine posts exactly one message: the greeting, tagged with the routine, waking nobody", async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["A conversation run should not have run."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Bom dia enviado."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: GREETING } }] };
    },
  });
  const routine = await channelRoutine(f, {
    name: "Bom dia diário",
    prompt: "Me dê um bom dia.",
    target: { type: "dm" },
    trigger: { type: "schedule", phrase: "30 8 * * *" },
  });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(f.provider.calls[0]?.request.system ?? "");
  expect(prompt).toContain("Never talk about this routine or its runs");
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const [rr] = await f.db.select().from(schema.routineRuns);
  const posted = await messagesIn(f, dm.id);
  expect(posted.map((m) => [m.authorType, m.authorAgentId, m.body])).toEqual([["agent", f.agent.id, GREETING]]);
  expect(posted[0]?.meta).toEqual({ routine: { id: routine.id, name: "Bom dia diário", runId: rr?.id } });
  // Only the routine's own run: nothing woke the agent in the DM.
  expect((await f.db.select().from(schema.agentRuns)).map((r) => r.background)).toEqual([true]);
  expect(rr).toMatchObject({ status: "reported", messageId: posted[0]?.id, summary: "Bom dia enviado." });
});

test("a watch routine with news that needs the agent hands off once: one notice, one run that tells the people", async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["O checkout voltou a falhar; vou reverter a 2.14 se vocês aprovarem."] };
      if (seen(req).includes("Handed off")) return { chunks: ["Checado: 12 erros no checkout, repassados."] };
      return {
        chunks: [],
        toolUses: [{ name: "hand_off", input: { message: "12 erros novos no checkout desde as 9h.", wake_me: true } }],
      };
    },
  });
  const routine = await channelRoutine(f, { prompt: "Vigie os erros do checkout e resolva o que aparecer." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const general = await messagesIn(f, f.general.id);
  expect(general.map((m) => (m.meta.notice as { kind?: string } | undefined)?.kind ?? "reply")).toEqual([
    "routine_handoff",
    "reply",
  ]);
  const runs = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  expect(runs.map((r) => [r.background, r.triggerMessageId === general[0]?.id])).toEqual([
    [true, false],
    [false, true],
  ]);
});

test("a when-new routine that found nothing posts nothing", async () => {
  f = await setup({ handOff: true, reply: () => ({ chunks: ["Nada novo: 0 erros desde ontem."] }) });
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  // Its final text is its record, and the routine is told that record is never posted.
  expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain("(it is never posted)");
  expect(await messagesIn(f, f.general.id)).toEqual([]);
  expect((await f.db.select().from(schema.agentRuns)).map((r) => r.background)).toEqual([true]);
  expect((await f.db.select().from(schema.routineRuns))[0]).toMatchObject({ status: "silent" });
});
