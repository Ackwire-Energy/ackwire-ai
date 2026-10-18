/**
 * Behavior eval: does an agent investigate before answering, cite what it
 * found, propose a concrete next step, ask only for decisions that are the
 * person's, and never act on sensitive things without approval? Cases come
 * from real failures (anonymized). Run it before shipping prompt changes
 * (context.ts, capabilities.ts, role presets). README.md next to this file
 * explains the case format.
 *
 * Manual, never in CI (it calls the real model and costs a little):
 *
 *   bun run eval:behavior [--only id,id] [--model claude-sonnet-5-5] [--judge-model claude-haiku-5-5]
 *                         [--no-judge] [--max-turns 12]
 *
 * Needs `ANTHROPIC_API_KEY` (in `.env`). `EVAL_AGENT_MODEL` / `EVAL_JUDGE_MODEL`
 * override the models. Cases: `behavior-cases.json`, plus
 * `behavior-cases.local.json` if present (never in git). The JSON report goes
 * to `eval/out/` (ignored by git).
 *
 * The run goes through the real path (`behavior-run.ts`): an in-memory
 * database (PGlite) seeded with the case, `postPersonMessage` → outbox →
 * `executeRun` (context.ts prompt, capabilities, Tool Gateway with scopes and
 * approvals, tool loop). Only the outside world is fake: connector tools
 * return canned results from the case. The model is real.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropicProvider } from "@agenteschat/providers";
import { type CheckResult, deterministicChecks } from "./behavior-checks";
import { type BehaviorCase, type CaseRun, clip, judge, runCase } from "./behavior-run";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("only")?.split(",");
const agentModel = arg("model") ?? process.env.EVAL_AGENT_MODEL;
const judgeModel = arg("judge-model") ?? process.env.EVAL_JUDGE_MODEL ?? "claude-haiku-5-5";
const useJudge = !process.argv.includes("--no-judge");
const maxToolTurns = Number(arg("max-turns") ?? 12);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is missing (put it in .env; the eval calls the real model).");
  process.exit(1);
}

const here = import.meta.dir;
const load = async (file: string): Promise<BehaviorCase[]> => {
  const f = Bun.file(join(here, file));
  return (await f.exists()) ? ((await f.json()) as BehaviorCase[]) : [];
};
const local = await load("behavior-cases.local.json");
const cases = [...(await load("behavior-cases.json")), ...local].filter((c) => !only || only.includes(c.id));
console.log(
  `${cases.length} cases (${local.length} local) · agent model ${agentModel ?? "per case"} · judge ${useJudge ? judgeModel : "off"} · max ${maxToolTurns} turns\n`,
);

interface CaseReport {
  id: string;
  title: string;
  pass: boolean;
  checks: CheckResult[];
  run: Omit<CaseRun, "system"> | null;
  /** The system prompt of the first turn, to see what the agent was told. */
  system?: string;
  costUsd: number;
  ms: number;
}

const provider = createAnthropicProvider();
const reports: CaseReport[] = [];
let totalNano = 0;
for (const c of cases) {
  const started = performance.now();
  let run: CaseRun | null = null;
  let checks: CheckResult[] = [];
  let nano = 0;
  try {
    run = await runCase(c, { apiKey, provider, maxToolTurns, agentModel });
    nano += run.costNanoUsd;
    checks = deterministicChecks(c.expect, run);
    if (useJudge) {
      const j = await judge(c, run, { apiKey, provider, model: judgeModel, agentModel });
      checks.push(...j.checks);
      nano += j.costNanoUsd;
    }
  } catch (error) {
    checks.push({ id: "ran", pass: false, detail: error instanceof Error ? error.message : String(error) });
  }
  totalNano += nano;
  const pass = checks.every((k) => k.pass);
  const { system, ...rest } = run ?? ({} as CaseRun);
  reports.push({
    id: c.id,
    title: c.title,
    pass,
    checks,
    run: run ? rest : null,
    system,
    costUsd: nano / 1e9,
    ms: Math.round(performance.now() - started),
  });
  console.log(`${pass ? "PASS" : "FAIL"} ${c.id} · ${c.title} · US$ ${(nano / 1e9).toFixed(4)}`);
  if (run) {
    const approval = run.approvals.length ? ` · approval: ${run.approvals.join(", ")}` : "";
    console.log(
      `  tools: ${run.calls.map((t) => t.name).join(", ") || "(none)"}${approval} · runs: ${run.status.join(", ")}`,
    );
    console.log(`  reply: ${clip((run.noReply ? "NO_REPLY" : run.reply).replace(/\s+/g, " "), 240)}`);
  }
  for (const k of checks) console.log(`  ${k.pass ? "ok  " : "FAIL"} ${k.id}: ${k.detail}`);
  console.log("");
}

// Totals per criterion.
const byCriterion = new Map<string, { pass: number; total: number }>();
for (const r of reports)
  for (const k of r.checks) {
    const m = byCriterion.get(k.id) ?? { pass: 0, total: 0 };
    m.total++;
    if (k.pass) m.pass++;
    byCriterion.set(k.id, m);
  }
const passed = reports.filter((r) => r.pass).length;
console.log(`── ${passed}/${reports.length} cases passed · US$ ${(totalNano / 1e9).toFixed(4)}`);
for (const [id, m] of [...byCriterion].sort((x, y) => x[0].localeCompare(y[0])))
  console.log(`  ${id.padEnd(30)} ${m.pass}/${m.total}`);

const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `behavior-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      agentModel: agentModel ?? null,
      judgeModel: useJudge ? judgeModel : null,
      maxToolTurns,
      passed,
      total: reports.length,
      costUsd: totalNano / 1e9,
      criteria: Object.fromEntries(byCriterion),
      cases: reports,
    },
    null,
    2,
  ),
);
console.log(`\nreport: ${file}`);
process.exit(passed === reports.length ? 0 : 1);
