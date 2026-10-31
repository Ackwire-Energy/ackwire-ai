/**
 * Mention hand-off eval (ADR 0034, ADR 0089): when an agent's message @mentions
 * another agent, is it handing that agent something to do now (it gets a run)
 * or only naming it (no run)? Scores every case with the production judge and
 * the production threshold (`mentionThreshold`, 0.6), with the message it
 * answers when there is one. Between agents with no turn cap, the judge also
 * tells a hand-back of the work or a question back (a run) from a thanks, an
 * "ok" or a sign-off (none), in Portuguese, English, Spanish, German, Japanese
 * and Arabic. It passes when every case is right: no courtesy at 0.6 or more,
 * every hand-back and question back at 0.6 or more.
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
  /** The message it answers (the trigger of the author's run). */
  answering?: { from: string; text: string };
}

const ada = { handle: "ada", name: "Ada", role: "Engenharia" };
const theo = { handle: "theo", name: "Theo", role: "Produto" };
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

type Kind = "handback" | "question_back" | "thanks" | "sign_off";

/**
 * The same four moments of Theo and Ada working together, in each language: Ada hands Theo back the review he asked
 * for and asks him something back (both hand-offs), and Theo thanks her or signs off (no hand-off, even addressed).
 */
const TOGETHER: Record<string, Record<Kind, { answering: string; body: string }>> = {
  pt: {
    handback: {
      answering: "@ada pode revisar o PR #12 antes do deploy?",
      body: "@theo revisei o PR #12: deixei dois comentários nos testes de checkout, é contigo para corrigir.",
    },
    question_back: { answering: "@ada puxa o churn de setembro?", body: "@theo você quer por plano ou só o total?" },
    thanks: { answering: "@theo churn de setembro: 3,2% no total, 5% no Pro.", body: "Valeu, @ada!" },
    sign_off: { answering: "@theo corrigi os testes e o CI passou.", body: "@ada perfeito, por aqui está fechado." },
  },
  en: {
    handback: {
      answering: "@ada can you review PR #12 before the deploy?",
      body: "@theo reviewed PR #12: I left two comments on the checkout tests, over to you to fix them.",
    },
    question_back: {
      answering: "@ada can you pull September's churn?",
      body: "@theo do you want it by plan or just the total?",
    },
    thanks: { answering: "@theo September churn: 3.2% overall, 5% on Pro.", body: "Thanks, @ada!" },
    sign_off: { answering: "@theo fixed the tests and CI is green.", body: "@ada perfect, all done on my side." },
  },
  es: {
    handback: {
      answering: "@ada ¿puedes revisar el PR #12 antes del deploy?",
      body: "@theo revisé el PR #12: dejé dos comentarios en los tests de checkout, te toca corregirlos.",
    },
    question_back: {
      answering: "@ada ¿puedes sacar el churn de septiembre?",
      body: "@theo ¿lo quieres por plan o solo el total?",
    },
    thanks: { answering: "@theo churn de septiembre: 3,2% en total, 5% en Pro.", body: "¡Gracias, @ada!" },
    sign_off: { answering: "@theo arreglé los tests y el CI pasó.", body: "@ada perfecto, por mi parte está cerrado." },
  },
  de: {
    handback: {
      answering: "@ada kannst du PR #12 vor dem Deploy reviewen?",
      body: "@theo PR #12 ist reviewt: zwei Kommentare zu den Checkout-Tests, jetzt bist du mit dem Fixen dran.",
    },
    question_back: {
      answering: "@ada kannst du den Churn vom September ziehen?",
      body: "@theo willst du ihn pro Plan oder nur gesamt?",
    },
    thanks: { answering: "@theo Churn im September: 3,2 % gesamt, 5 % bei Pro.", body: "Danke, @ada!" },
    sign_off: {
      answering: "@theo Tests gefixt, die CI ist grün.",
      body: "@ada super, von meiner Seite ist alles erledigt.",
    },
  },
  ja: {
    handback: {
      answering: "@ada デプロイ前にPR #12をレビューしてもらえますか？",
      body: "@theo PR #12をレビューしました。チェックアウトのテストに2件コメントを残したので、修正をお願いします。",
    },
    question_back: {
      answering: "@ada 9月のチャーンを出してもらえますか？",
      body: "@theo プラン別がいいですか、それとも合計だけですか？",
    },
    thanks: { answering: "@theo 9月のチャーンは全体で3.2%、Proで5%です。", body: "@ada ありがとう！" },
    sign_off: { answering: "@theo テストを直してCIも通りました。", body: "@ada 完璧です、こちらはこれで完了です。" },
  },
  ar: {
    handback: {
      answering: "@ada هل يمكنك مراجعة PR #12 قبل النشر؟",
      body: "@theo راجعت PR #12: تركت تعليقين على اختبارات الدفع، الدور عليك لإصلاحهما.",
    },
    question_back: {
      answering: "@ada هل يمكنك استخراج معدل الإلغاء لشهر سبتمبر؟",
      body: "@theo هل تريده حسب الخطة أم الإجمالي فقط؟",
    },
    thanks: { answering: "@theo معدل الإلغاء في سبتمبر: 3.2% إجمالاً و5% في Pro.", body: "شكراً يا @ada!" },
    sign_off: { answering: "@theo أصلحت الاختبارات ونجح الـ CI.", body: "@ada ممتاز، انتهى الأمر من جهتي." },
  },
};

for (const [language, moments] of Object.entries(TOGETHER)) {
  for (const [kind, m] of Object.entries(moments) as [Kind, { answering: string; body: string }][]) {
    // A hand-back or a question back is Ada's, to Theo; a thanks or a sign-off is Theo's, to Ada.
    const fromAda = kind === "handback" || kind === "question_back";
    CASES.push({
      id: `${language}-${kind}`,
      handoff: fromAda,
      from: fromAda ? "ada" : "theo",
      to: fromAda ? theo : ada,
      body: m.body,
      answering: { from: fromAda ? "@theo" : "@ada", text: m.answering },
    });
  }
}

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
      answering: c.answering ?? null,
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
