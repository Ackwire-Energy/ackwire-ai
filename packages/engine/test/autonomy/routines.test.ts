import { afterEach, expect } from "bun:test";
import { schema } from "@agenteschat/db";
import { createRoutine, executeRoutineRun, queueRoutineRun } from "../../src";
import { routineDeps, routineRow, routineRunRow } from "../routine-fixtures";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";
import { openPullRequestTool } from "./tools";

// Routines (ADR 0053) against I3, I4, I6 and I7: what one hands to an agent can be done, what a read one limits is
// said, a quiet one stays quiet, and one that could never fire is refused.

afterEach(closeWorlds);

/** An hourly routine of `handle` reporting to the scenario's channel, fired once now; settles. */
async function fireRoutine(w: World, handle: string, prompt: string, access: "read" | "act") {
  const routine = await createRoutine(routineDeps(w.f), w.owner.id, w.org.id, {
    name: "Sentry",
    agentId: w.agents[handle]?.id ?? "",
    prompt,
    target: { type: "channel", channelId: w.channelId },
    trigger: { type: "schedule", phrase: "a cada hora" },
    access,
  });
  const queued = await queueRoutineRun({ db: w.db }, await routineRow(w.f, routine.id), new Date(), "manual");
  if (!queued) throw new Error("not queued");
  await executeRoutineRun(routineDeps(w.f), queued.id);
  await w.settle();
  return routineRunRow(w.f, queued.id);
}

scenario("S25", "a routine set to act hands an error to an agent, which fixes it", async () => {
  const w = await world({
    agents: ["sentinela", "lia"],
    setup: { toolSources: [openPullRequestTool()] },
    script: {
      sentinela: [
        {
          calls: [
            {
              name: "tell_agent",
              input: { agent: "@lia", message: "Erro novo no Sentry: TypeError em checkout.ts:42." },
            },
          ],
        },
        { calls: [{ name: "hand_off", input: { message: "Passei o TypeError de checkout.ts:42 para a Lia." } }] },
        { text: "Feito." },
        // The run the routine's report wakes, then the one Lia's result wakes in the same conversation.
        { text: "Erro novo no checkout (TypeError em checkout.ts:42): passei para a Lia." },
        { text: "A Lia corrigiu o TypeError do checkout no PR #230." },
      ],
      lia: [
        { calls: [{ name: "open_pull_request", input: { repo: "acme/app", title: "Fix TypeError checkout" } }] },
        { text: "Corrigi o TypeError de checkout.ts:42: PR #230." },
      ],
    },
  });
  await w.grant("lia", ["github:pr.write"]);
  await fireRoutine(w, "sentinela", "Checa o Sentry e passa os erros novos para @lia.", "act");
  expect((await w.calls("sentinela")).find((c) => c.name === "tell_agent")?.isError).toBe(false);
  expect((await w.calls("lia")).map((c) => [c.name, c.isError])).toEqual([["open_pull_request", false]]);
  await assertInvariants(w);
});

scenario("S26", "a routine set to only look says who limited it, and its report run can still ask", async () => {
  const w = await world({
    agents: ["otto"],
    script: {
      otto: ({ system, n }) => {
        if (n === 1)
          // A decision for the people there (whether the routine may fix them): `wake_me`, so a report run asks it.
          return {
            calls: [{ name: "hand_off", input: { message: "3 erros novos no checkout desde as 9h.", wake_me: true } }],
          };
        if (n === 2) return { text: "Entreguei." };
        if (system.includes("routine") && n === 3)
          return {
            calls: [
              {
                name: "ask_user",
                input: {
                  question: "Quer que essa rotina passe a corrigir sozinha os erros do checkout?",
                  choices: ["Sim", "Não"],
                  why: "A rotina só olha: os 3 erros do checkout ficam abertos até alguém corrigir.",
                },
              },
            ],
          };
        return undefined;
      },
    },
  });
  await fireRoutine(w, "otto", "Checa os erros novos do checkout.", "read");
  const background = w.prompts("otto")[0] ?? "";
  // The run is told who set it to only look (I7), not only that it can't act.
  expect(/What it may do: [^\n]*\bana\b/i.test(background)).toBe(true);
  const asks = (await w.calls("otto")).filter((c) => c.name === "ask_user");
  expect(asks.map((c) => [c.isError, c.result])).toEqual([[false, expect.any(String)]]);
  await assertInvariants(w);
});

scenario("S27", "a routine with nothing new posts nothing and wakes nobody", async () => {
  const w = await world({
    agents: ["sentinela", "lia"],
    script: { sentinela: [{ text: "Nada novo desde ontem.\n\nNO_REPLY" }] },
  });
  const ledger = await fireRoutine(w, "sentinela", "Checa o Sentry.", "read");
  expect(ledger.status).not.toBe("failed");
  expect(await w.posts()).toEqual([]);
  expect((await w.runs()).length).toBe(1);
  await assertInvariants(w);
});

scenario(
  "S39",
  "an event routine nothing can ever fire is refused when it is created, with the setup step",
  async () => {
    const w = await world({
      agents: ["otto"],
      script: {
        otto: [
          {
            calls: [
              {
                name: "create_routine",
                input: { prompt: "Revisa cada PR novo.", trigger: { type: "event", event: "github.pr_opened" } },
              },
            ],
          },
          { text: "Não consegui criar: falta conectar o GitHub ao workspace." },
        ],
      },
    });
    await w.say("@otto revisa cada PR novo que abrirem");
    await w.settle();
    const [call] = (await w.calls("otto")).filter((c) => c.name === "create_routine");
    expect(call?.isError).toBe(true);
    expect(await w.db.select().from(schema.routines)).toEqual([]);
    await assertInvariants(w);
  },
);

scenario("S50", "a routine told to go on keeps what its first turn found in its record", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: (s) => (String(s.reply).includes("Vou abrir") ? "continue" : "done") },
    script: {
      otto: [
        { text: "Achei 3 erros novos no Sentry: login, export e push. Vou abrir as issues." },
        { text: "Issues abertas." },
      ],
    },
  });
  const run = await fireRoutine(w, "otto", "Checa o Sentry e abre issues dos erros novos.", "act");
  expect(run?.summary).toContain("Achei 3 erros novos");
  expect(run?.summary).toContain("Issues abertas.");
  await assertInvariants(w);
});

scenario(
  "S51",
  "a routine that already posted ends there: a next check named in its record is no promise",
  async () => {
    const w = await world({
      agents: ["otto"],
      judge: { followThrough: (s) => (String(s.reply).includes("amanhã") ? "continue" : "done") },
      script: {
        otto: [
          { calls: [{ name: "hand_off", input: { message: "Bom dia! Nenhum erro novo no Sentry." } }] },
          { text: "Resumo postado. Checo de novo amanhã às 8h." },
          { text: "A conversation run should not have run." },
        ],
      },
    });
    const run = await fireRoutine(w, "otto", "Me dê um bom dia com o resumo do Sentry.", "act");
    expect(run?.status).toBe("reported");
    expect(w.judgedAs("follow_through")).toEqual([]);
    expect((await w.calls("otto")).map((c) => c.name)).toEqual(["hand_off"]);
    expect((await w.posts()).map((p) => p.body)).toEqual(["Bom dia! Nenhum erro novo no Sentry."]);
    await assertInvariants(w);
  },
);
