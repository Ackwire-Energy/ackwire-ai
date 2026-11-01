import { afterEach, expect } from "bun:test";
import { createRoutine, createWebToolSource, executeRoutineRun, queueRoutineRun } from "../../src";
import { routineDeps, routineRow, routineRunRow } from "../routine-fixtures";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";

// Resourceful agents (ADR 0109) against I5 and I6: a run that says it couldn't while it still had ways is told its
// means once, a real blocker or a plain answer is never nudged, and a routine's give-up report is held only once.

afterEach(closeWorlds);

const NEWS = `<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fbanco-azul">Banco Azul lança cartão novo</a><a class="result__snippet" href="#">O Banco Azul anunciou nesta semana um cartão sem anuidade.</a></div>`;

/** The web source with a fake web: DuckDuckGo answers the news above, every page is a 403. */
const fakeWeb = () =>
  createWebToolSource({
    fetch: async (url) =>
      url.startsWith("https://html.duckduckgo.com/")
        ? new Response(`<html><body>${NEWS}</body></html>`, { status: 200 })
        : new Response("Forbidden", { status: 403 }),
    resolveHost: async () => ["93.184.216.34"],
  });

/** The rubric, as a judge would read it: "couldn't" with fewer than two attempts and no person-only blocker. */
const rubric = (state: Record<string, unknown>) => {
  const reply = String(state.reply);
  const tried = (state.tried ?? []) as string[];
  const gaveUp = /não (tenho|consigo|consegui)/i.test(reply);
  const blocker = /código|senha|pagamento/i.test(reply);
  return gaveUp && !blocker && tried.length < 2 ? "untried" : "done";
};

async function fireRoutine(w: World, handle: string, prompt: string) {
  const routine = await createRoutine(routineDeps(w.f), w.owner.id, w.org.id, {
    name: "Notícias",
    agentId: w.agents[handle]?.id ?? "",
    prompt,
    target: { type: "channel", channelId: w.channelId },
    trigger: { type: "schedule", phrase: "a cada hora" },
  });
  const queued = await queueRoutineRun({ db: w.db }, await routineRow(w.f, routine.id), new Date(), "manual");
  if (!queued) throw new Error("not queued");
  await executeRoutineRun(routineDeps(w.f), queued.id);
  await w.settle();
  return routineRunRow(w.f, queued.id);
}

const untriedSteps = async (w: World) =>
  (await w.steps((await w.runs()).map((r) => r.id))).filter(
    (s) => s.kind === "context" && (s.data as { nudged?: string }).nudged === "untried",
  );

scenario(
  "S54",
  "the weekly news routine that gave up without searching is held once, searches, and posts",
  async () => {
    const w = await world({
      agents: ["rui"],
      setup: { toolSources: [fakeWeb()] },
      judge: { followThrough: rubric },
      script: {
        rui: [
          {
            calls: [{ name: "hand_off", input: { message: "Não tenho ferramenta de busca na web; alguém pesquisa?" } }],
          },
          { calls: [{ name: "web_search", input: { query: "Banco Azul notícias" } }] },
          {
            calls: [
              { name: "hand_off", input: { message: "Resumo da semana: o Banco Azul lançou um cartão sem anuidade." } },
            ],
          },
          { text: "Busquei na web e postei o resumo." },
        ],
      },
    });
    const run = await fireRoutine(w, "rui", "Todo domingo pesquise notícias sobre o Banco Azul e me dê um resumo.");
    expect(run?.status).toBe("reported");
    expect((await w.posts()).map((p) => p.body)).toEqual([
      "Resumo da semana: o Banco Azul lançou um cartão sem anuidade.",
    ]);
    const calls = await w.calls("rui");
    expect(calls.map((c) => c.name)).toEqual(["hand_off", "web_search", "hand_off"]);
    // The held report answers with the nudge, naming the web among its means.
    expect(calls[0]?.result).toContain("Not posted yet");
    expect(calls[0]?.result).toContain("web_search");
    expect(calls[1]?.result).toContain("https://news.example.com/banco-azul");
    // The judge read what the run really has.
    const [held] = w.judgedAs("follow_through");
    expect(((held?.state.means ?? []) as string[]).join(" ")).toContain("web_search");
    expect(await untriedSteps(w)).toHaveLength(1);
    await assertInvariants(w);
  },
);

scenario("S55", "a routine's second give-up report always posts: the hold is once", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: () => "untried" },
    script: {
      rui: [
        { calls: [{ name: "hand_off", input: { message: "Não consegui as notícias." } }] },
        { calls: [{ name: "hand_off", input: { message: "Não consegui as notícias desta semana." } }] },
        { text: "Relatado." },
      ],
    },
  });
  const run = await fireRoutine(w, "rui", "Pesquise notícias sobre o Banco Azul.");
  expect(run?.status).toBe("reported");
  expect((await w.posts()).map((p) => p.body)).toEqual(["Não consegui as notícias desta semana."]);
  // One judgment for the first report; the second posts without one, and the run's turn end doesn't judge again.
  expect(w.judgedAs("follow_through")).toHaveLength(1);
  expect(await untriedSteps(w)).toHaveLength(1);
  await assertInvariants(w);
});

scenario("S56", "a 'couldn't' with one empty attempt is told its means once, then answers", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: rubric },
    script: {
      rui: [
        { calls: [{ name: "web_fetch", input: { url: "https://www.google.com/search?q=banco+azul" } }] },
        { text: "Não consigo pesquisar: o Google bloqueou." },
        { calls: [{ name: "web_search", input: { query: "Banco Azul notícias" } }] },
        { text: "O Banco Azul lançou um cartão sem anuidade nesta semana." },
      ],
    },
  });
  await w.say("@rui quais as notícias do Banco Azul?");
  await w.settle();
  expect((await w.calls("rui")).map((c) => [c.name, c.isError])).toEqual([
    ["web_fetch", true],
    ["web_search", false],
  ]);
  const [first] = w.judgedAs("follow_through");
  expect(first?.state.tried).toEqual([
    expect.stringContaining("web_fetch(https://www.google.com/search?q=banco+azul) → failed"),
  ]);
  // Its next turn read the nudge with its means.
  expect(
    w.f.provider.calls.some((c) => JSON.stringify(c.request.messages).includes("You ended saying you couldn't")),
  ).toBe(true);
  expect((await w.posts("rui")).at(-1)?.body).toContain("cartão sem anuidade");
  expect(await untriedSteps(w)).toHaveLength(1);
  await assertInvariants(w);
});

scenario("S57", "a blocker only a person can clear, after real attempts, is not nudged", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: rubric },
    script: {
      rui: [
        { calls: [{ name: "web_fetch", input: { url: "https://banco.example.com/extrato" } }] },
        {
          text: "Não consegui abrir o extrato: o site pede o código de verificação que chega no seu celular. Tentei o site direto. Me passe o código.",
        },
      ],
    },
  });
  await w.say("@rui pega o extrato do mês no site do banco");
  await w.settle();
  expect(w.prompts("rui")).toHaveLength(2);
  expect(await untriedSteps(w)).toHaveLength(0);
  await assertInvariants(w);
});

scenario("S58", "a plain answer with nothing in the way gets no nudge and no extra turn", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: rubric },
    script: { rui: [{ text: "Domingo às 9h, como combinado." }] },
  });
  await w.say("@rui que horas sai o resumo?");
  await w.settle();
  expect(w.prompts("rui")).toHaveLength(1);
  expect(await untriedSteps(w)).toHaveLength(0);
  await assertInvariants(w);
});
