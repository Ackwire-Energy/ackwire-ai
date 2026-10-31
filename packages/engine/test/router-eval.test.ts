import { expect, test } from "bun:test";
import { ROUTER_CASES, type RouterCase, routerEval, TEAM } from "../eval/router";
import { createJevRouterStrategy } from "../src";

// The router eval's cases and harness, with a fake Jev (no network). The eval itself is manual:
// `bun run eval:router`.

test("every case is well formed: known agents, no @mention, and each language asks the four ways", () => {
  const handles = new Set(TEAM.map((a) => a.handle));
  const ids = new Set<string>();
  for (const c of ROUTER_CASES) {
    expect(ids.has(c.id), c.id).toBe(false);
    ids.add(c.id);
    expect(c.answers !== undefined || c.not !== undefined, c.id).toBe(true);
    for (const h of [...(c.answers ?? []), ...(c.not ?? [])]) expect(handles.has(h), `${c.id}: ${h}`).toBe(true);
    expect(c.message, c.id).not.toContain("@");
  }
  for (const lang of ["pt", "en", "es", "de", "ja", "ar"])
    for (const kind of ["asks", "direct", "anyone", "about"])
      expect(
        ROUTER_CASES.some((c) => c.lang === lang && c.kind === kind),
        `${lang} ${kind}`,
      ).toBe(true);
});

/** Jev as it answered on 2026-10-31, plus the addressee Choice's probabilities when given. */
function jevThatDay(to?: Record<string, number>) {
  const states: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { state, questions } = JSON.parse(String(init.body)) as {
      state: unknown;
      questions: Record<string, { instructions: { agent?: { handle: string } } }>;
    };
    states.push(state);
    const nouls: Record<string, number> = { "@theo": 0.9, "@ada": 0.52 };
    const answers: Record<string, unknown> = {
      needs_agent: { noul: 0.78 },
      for_everyone: { noul: 0.1 },
      best_agent: { choice: "theo", probabilities: { theo: 0.79 }, confidence: 0.79 },
    };
    for (const [id, q] of Object.entries(questions))
      if (id.startsWith("agent_")) answers[id] = { noul: nouls[q.instructions.agent?.handle ?? ""] ?? 0.05 };
    if (to && questions.addressee) answers.addressee = { choice: "ada", probabilities: to, confidence: 0.8 };
    return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 1500 } });
  }) as unknown as typeof fetch;
  return { states, strategy: createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: fetcher }) };
}

test("the harness: the day's case fails on that day's answers and passes once the step hears Ada", async () => {
  const day = ROUTER_CASES.find((c) => c.id === "pt-production") as RouterCase;
  const evaluation = await routerEval();
  try {
    const then = jevThatDay();
    expect(await evaluation.run(day, then.strategy)).toMatchObject({ ok: false, picked: ["theo"] });
    // The step reads each agent's apps, as in production.
    expect(JSON.stringify(then.states[0])).toContain("Gmail");
    const now = jevThatDay({ ada: 0.86, theo: 0.08, none: 0.06 });
    expect(await evaluation.run(day, now.strategy)).toMatchObject({ ok: true, picked: ["ada"] });
  } finally {
    await evaluation.close();
  }
});
