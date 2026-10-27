/**
 * Mention hand-off eval (ADR 0034): when an agent's message @mentions another
 * agent, is it handing that agent something to do now (it gets a run) or only
 * naming it (no run)? Scores every case with the production judge and the
 * production threshold (`mentionThreshold`, 0.6).
 *
 * Manual, never in CI (it calls the real service and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/mention-handoff.ts [--judge jev|llm]
 *
 * Needs `TYPESAFE_API_KEY` (Jev, as in production) or `ANTHROPIC_API_KEY` for
 * the LLM fallback (`EVAL_LLM_MODEL`, default claude-haiku-5-5).
 */
import { createAnthropicProvider } from "@agenteschat/providers";
import { createJevJudge, createLlmJudge, type Judge, mentionHandoffs } from "../src/judge";

interface Case {
  id: string;
  /** True when the mentioned agent should act now. */
  handoff: boolean;
  from: string;
  to: { handle: string; name: string; role: string };
  body: string;
}

const ada = { handle: "ada", name: "Ada", role: "Engenharia" };
const nina = { handle: "nina", name: "Nina", role: "Dados" };
const atlas = { handle: "atlas", name: "Atlas", role: "Observabilidade" };

const CASES: Case[] = [
  {
    id: "offer-after-approval",
    handoff: false,
    from: "theo",
    to: ada,
    body: "Quatro dos cinco negativos aconteceram logo depois de `subscription_completed`, e as cinco pessoas são Pro. O último positivo foi em 16/10. Na prática, pedir a avaliação logo depois da compra só tem gerado negativos. Minha recomendação é tirar o prompt desse momento e deixar só gatilhos de uso, como exportar o PDF ou terminar uma viagem. Se você concordar, abro a issue para a @ada.",
  },
  {
    id: "if-you-want",
    handoff: false,
    from: "theo",
    to: ada,
    body: "Se quiser, peço para a @ada abrir o PR ainda hoje.",
  },
  {
    id: "past-work",
    handoff: false,
    from: "theo",
    to: ada,
    body: "A @ada já corrigiu isso ontem no PR #412, está em produção.",
  },
  {
    id: "asks-person-who",
    handoff: false,
    from: "theo",
    to: ada,
    body: "Walter, você prefere que eu cuide disso ou que a @ada pegue?",
  },
  {
    id: "talk-to",
    handoff: false,
    from: "theo",
    to: nina,
    body: "Fala com a @nina, ela tem os dados de churn por plano.",
  },
  {
    id: "after-approval",
    handoff: false,
    from: "theo",
    to: ada,
    body: "Depois que você aprovar o texto, a @ada consegue subir a mudança.",
  },
  {
    id: "en-offer",
    handoff: false,
    from: "theo",
    to: ada,
    body: "I'd drop the review prompt after checkout. Want me to open an issue for @ada?",
  },
  {
    id: "direct-request",
    handoff: true,
    from: "theo",
    to: ada,
    body: "@ada, pode abrir o PR que tira o prompt de review depois da compra?",
  },
  {
    id: "data-pull",
    handoff: true,
    from: "theo",
    to: nina,
    body: "@nina puxa os números de churn de setembro por plano, por favor.",
  },
  {
    id: "issue-assigned",
    handoff: true,
    from: "theo",
    to: ada,
    body: "Abri a issue #131. @ada, é contigo: o timeout está no cálculo de frete.",
  },
  {
    id: "question-now",
    handoff: true,
    from: "theo",
    to: atlas,
    body: "@atlas você viu algum erro novo no Sentry desde as 14h?",
  },
  {
    id: "approved-go",
    handoff: true,
    from: "theo",
    to: ada,
    body: "O Walter aprovou. @ada, segue com o PR que tira o prompt depois da compra.",
  },
  {
    id: "en-request",
    handoff: true,
    from: "theo",
    to: nina,
    body: "@nina can you pull last week's signups by source?",
  },
  {
    id: "findings-then-ask",
    handoff: true,
    from: "atlas",
    to: ada,
    body: "Taxa de erro subiu para 3% no checkout desde as 14h, tudo no `calcShipping`. @ada, consegue olhar agora?",
  },
];

const THRESHOLD = 0.6;
const ORG = "00000000-0000-0000-0000-000000000000";
const which = process.argv.includes("--judge") ? process.argv[process.argv.indexOf("--judge") + 1] : "jev";
const noUsage = { recordExternalUsage: async () => null };

let judge: Judge;
if (which === "jev") {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is missing (or run with --judge llm)");
  judge = createJevJudge({ key: apiKey, gateway: noUsage, timeoutMs: 10_000 });
} else {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
  const provider = createAnthropicProvider();
  const model = process.env.EVAL_LLM_MODEL ?? "claude-haiku-5-5";
  judge = createLlmJudge({
    gateway: {
      complete: (async (call: Parameters<typeof provider.stream>[0]) =>
        provider.stream(call, { apiKey, onDelta: () => {} })) as never,
    },
    resolveModel: async () => model,
  });
}

let right = 0;
const rows = await Promise.all(
  CASES.map(async (c) => {
    const scores = await mentionHandoffs(judge, {
      orgId: ORG,
      body: c.body,
      author: `@${c.from}`,
      targets: [{ agentId: c.to.handle, handle: c.to.handle, name: c.to.name, role: c.to.role }],
    });
    const p = scores.get(c.to.handle) ?? 0;
    return { c, p, ok: p >= THRESHOLD === c.handoff };
  }),
);
for (const { c, p, ok } of rows) {
  if (ok) right++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${p.toFixed(2)}  ${c.handoff ? "hand-off " : "reference"}  ${c.id}`);
}
console.log(`\n${right}/${CASES.length} right (${which}, threshold ${THRESHOLD})`);
process.exit(right === CASES.length ? 0 : 1);
