import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelMessage, type ModelRequest, ProviderError, textOf } from "@agenteschat/providers";
import { drainOutbox, postPersonMessage, saveAgentStyle, type ToolSource } from "../src";
import { advance, computerWork, decideTurnEnd, localPathsCited, type TurnEnd } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * Nobody can open the agent's computer: a reply that cites a file there as if people could ("Salvei em
 * `notas/precos.md`") is written again once, unposted, with the file shared or what it holds, unless the person
 * writes paths or code themselves, or the run works in a repository or a mission.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** As if its computer worked on every file the reply names (`computerWork`), so only the words decide. */
const cited = (reply: string, request = "") => localPathsCited(reply, request, { touched: reply, shared: "" });

describe("a path on the agent's computer", () => {
  test("found in backticks or bare, folders too, in Portuguese and English", () => {
    expect(cited("Salvei o saldo em `notas/tabela-precos.md` e o resto em notas/.")).toEqual([
      "notas/tabela-precos.md",
      "notas/",
    ]);
    expect(cited("Está em ~/relatorios/ e em /home/agente/out.csv.")).toEqual([
      "~/relatorios/",
      "/home/agente/out.csv",
    ]);
    expect(cited("I saved it to ~/out/ and the table is in /home/agent/x.csv")).toEqual([
      "~/out/",
      "/home/agent/x.csv",
    ]);
    expect(cited("The draft is at drafts/q3-plan.docx, see ./export/summary.pdf.")).toEqual([
      "drafts/q3-plan.docx",
      "./export/summary.pdf",
    ]);
    expect(cited("Vendas: (ver `relatorios/vendas-outubro.xlsx`)")).toEqual(["relatorios/vendas-outubro.xlsx"]);
    // A source file under a home folder is still on its computer.
    expect(cited("Rodei /home/agent/app/run.py.")).toEqual(["/home/agent/app/run.py"]);
  });

  test("never an address, a mail, a wiki link, a code block, a ratio, a unit, a pair, a date or a version", () => {
    const words = [
      "Veja https://example.com/docs/guia.md, www.example.com/precos e example.com/planos.",
      "See github.com/example/repo/blob/main/README.md and docs.example.com/v2/intro.html",
      "Está na página [[Processos/Deploy]] da wiki, escreva para ana@example.com.",
      "Written up in [[Sales/Q3 notes]]; mail bob.smith@example.com/ops if needed.",
      "Rode:\n```\ncat notas/precos.md\n```",
      "Run this:\n```bash\ncp ~/out/report.pdf ./share/\n```",
      "Use e/ou, 24/7, 80 km/h, R$ 49/mês, 09/11/2026, c/ desconto, A/B e Pessoal/Equipe/Empresa.",
      "Use and/or, 24/7, 60 mph, $9/mo, 11/09/2026, w/ the team, TCP/IP, I/O, km/h. and m/s².",
      "Planos s/ juros p/ você, 1/2 xícara, 3/4 do time, nov/2026, seg/sex.",
      "Upgrade from v1.2/v1.3 and HTTP/1.1 to HTTP/2; S.A./Ltda. both work.",
      "Times: Vendas/Marketing, Product/Design, Suporte/CS.",
      "Compare Remix/Next.js and Deno/Node.js before choosing.",
      "The API answers on /api/users and /v2/orders/, see /docs/intro.html.",
      "Ok, @dev/ops vai olhar isso.",
      "Postei em #vendas/#suporte e em #geral/.",
      "Use Gmail/Outlook.com, tanto faz.",
      "Poste no Instagram/X.com e no site example.com.br/blog/.",
      "Vendemos no Mercado Livre/Amazon.com.br e na Loja/Shop.dev.",
      "Comprei na Kalunga/Kabum.com.br.",
      "Publicado em owner/name.github.io.",
      "Rode em localhost:3000/api/health.json e veja 127.0.0.1:8080/status/.",
    ];
    for (const reply of words) expect({ reply, cited: cited(reply) }).toEqual({ reply, cited: [] });
  });

  test("a reply that names source code is code talk, all of it", () => {
    expect(cited("Corrigi em `src/login.ts` e os testes em test/login.test.ts passam.")).toEqual([]);
    expect(cited("Fixed it in src/auth/session.py and lib/util.rb.", "corrige o login")).toEqual([]);
    expect(cited("Corrigi o bug em `apps/web/src/App.tsx` e atualizei `apps/web/package.json`.")).toEqual([]);
    expect(cited("Changed src/app.ts, docs/README.md and package.json, PR is open.")).toEqual([]);
  });

  test("a person who writes paths or code, or names the file, reads them: their chat is about files", () => {
    const reply = "Atualizei `notas/planos.md` e salvei a cópia em ~/backup/.";
    expect(cited(reply, "atualiza o notas/planos.md")).toEqual([]);
    expect(cited(reply, "olha esse erro:\n```\nTypeError\n```")).toEqual([]);
    expect(cited(reply, "atualiza as notas dos planos")).toEqual(["notas/planos.md", "~/backup/"]);
    // A web address in the message is no path of theirs.
    expect(cited(reply, "olha https://example.com/planos/precos.html")).toEqual(["notas/planos.md", "~/backup/"]);
    // A code file or a path from the root is theirs too.
    expect(
      cited("Em src/login.ts a função valida; a config fica em config/auth.json", "O que tem em src/login.ts?"),
    ).toEqual([]);
    expect(cited("O endpoint lê de data/users.csv", "Por que /api/users/ está lento?")).toEqual([]);
    expect(cited("The handler reads data/users.csv", "why is /api/users slow?")).toEqual([]);
    // They named the file without its folder.
    expect(cited("O total em notas/precos.md é R$ 300.", "qual o total do precos.md?")).toEqual([]);
    expect(cited("The total in notes/Prices.csv is $300.", "what's the total in prices.csv?")).toEqual([]);
    // A date, a pair or a ratio in the message writes no path: the check stays on.
    for (const request of [
      "faz o relatório de 01/11 a 14/11",
      "make the report for 11/01-11/14",
      "manda por e-mail e/ou no chat, 24/7",
      "o plano custa R$ 49/mês?",
    ])
      expect({ request, cited: cited(reply, request) }).toEqual({ request, cited: ["notas/planos.md", "~/backup/"] });
  });

  test("only what its computer worked on in this run, and never what it already shared", () => {
    const none = { touched: "", shared: "" };
    const elsewhere = [
      "Salvei no seu Google Drive em Marketing/Campanhas/briefing.docx.",
      "Coloquei no Dropbox: Clientes/2026/contrato.pdf",
      "No Drive: Financeiro/orcamento.xlsx, e a pasta Relatórios/2025/.",
      "Baixe em Downloads/relatorio.pdf no seu computador.",
      "Criei a página na pasta Financeiro/Contratos/ do wiki, e as notas em Minhas Notas/.",
      "Abri o PR #42: muda docs/setup.md e public/logo.svg.",
      "Put it in your SharePoint under Sales/Q3/deck.pptx.",
    ];
    for (const reply of elsewhere)
      expect({ reply, cited: localPathsCited(reply, "", none) }).toEqual({ reply, cited: [] });
    const reply = "Salvei o resumo em `notas/planos.md` e a tabela em out/precos.csv.";
    const work = { touched: '{"path":"notas/planos.md"}\nWrote out/precos.csv', shared: "" };
    expect(localPathsCited(reply, "", work)).toEqual(["notas/planos.md", "out/precos.csv"]);
    expect(localPathsCited(reply, "", { ...work, shared: '{"path":"out/precos.csv"}' })).toEqual(["notas/planos.md"]);
    // A whole name only: "out" isn't in "stdout", nor "docs" in "mydocs", nor "data" in "metadata".
    const folders = "Salvei em out/, docs/ e data/.";
    const words = { touched: '{"code":"print(1)"}\nstdout: ok\nmydocs about metadata', shared: "" };
    expect(localPathsCited(folders, "", words)).toEqual([]);
    expect(localPathsCited(folders, "", { touched: '{"path":"out/a.csv"}\nls docs', shared: "" })).toEqual([
      "out/",
      "docs/",
    ]);
    // A name with one more suffix is another file: "precos.md.bak" isn't "precos.md".
    expect(
      localPathsCited("Salvei em notas/precos.md.", "", { touched: '{"path":"notas/precos.md.bak"}', shared: "" }),
    ).toEqual([]);
    // The person named it as a whole word only: asking about "anotas" names no "notas/".
    expect(
      localPathsCited("Está em notas/.", "o que tem nas anotas?", { touched: '{"path":"notas/a.md"}', shared: "" }),
    ).toEqual(["notas/"]);
  });

  test("what its computer did is read only when the reply has a path to check", () => {
    let read = 0;
    const work = () => {
      read++;
      return { touched: '{"path":"notas/planos.md"}', shared: "" };
    };
    expect(localPathsCited("Pronto, o Básico custa US$ 9 por mês.", "", work)).toEqual([]);
    expect(localPathsCited("Use e/ou, 24/7 e veja example.com/precos.", "", work)).toEqual([]);
    expect(read).toBe(0);
    expect(localPathsCited("Salvei em notas/planos.md.", "", work)).toEqual(["notas/planos.md"]);
    expect(read).toBe(1);
  });

  test("its computer's work: its calls and their results, what it shared apart, nothing from other tools", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "monta o resumo" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "write_file", input: { path: "notas/planos.md" } },
          { type: "tool_use", id: "b", name: "run_code", input: { code: "ls" } },
          { type: "tool_use", id: "c", name: "upload_file", input: { path: "out/precos.csv" } },
          { type: "tool_use", id: "d", name: "drive_search", input: { query: "Financeiro/orcamento.xlsx" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "a", content: "written" },
          { type: "tool_result", toolUseId: "b", content: "relatorios/\nvendas.xlsx" },
          { type: "tool_result", toolUseId: "c", content: "shared" },
          { type: "tool_result", toolUseId: "d", content: "Contratos/2026/acordo.pdf" },
        ],
      },
    ];
    const work = computerWork(messages, new Set(["write_file", "run_code", "upload_file"]));
    expect(work.touched).toContain("notas/planos.md");
    expect(work.touched).toContain("vendas.xlsx");
    expect(work.touched).not.toContain("orcamento");
    expect(work.touched).not.toContain("acordo");
    expect(work.touched).not.toContain("precos");
    expect(work.shared).toContain("out/precos.csv");
  });

  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Salvei em `notas/precos.md`.",
    mission: false,
    localPaths: ["notas/precos.md"],
    wakesLater: async () => false,
    verdict: async () => "done",
    ...over,
  });

  test("written again once, judge or not, not counted against the nudges; never between agents nor past a bound", async () => {
    const d = await decideTurnEnd(turn());
    expect(d).toMatchObject({ outcome: "continue", rule: "local_paths" });
    expect(d.nudge).toStartWith(
      "Not posted: your reply cites files on your computer (`notas/precos.md`), which nobody else can open",
    );
    expect(d.nudge).toContain("upload_file");
    expect(d.nudge).toContain("export_file");
    expect(d.nudge).toContain("[[Title]]");
    const next = advance({ count: 0 }, d, 0);
    expect(next).toEqual({ count: 0, pathsNudged: true });
    expect(advance({ count: 0, askNudged: true, askPending: true }, d, 0)).toMatchObject({ askPending: true });
    expect(await decideTurnEnd(turn({ state: next }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ verdict: null }))).toMatchObject({ rule: "local_paths" });
    // Even with the nudges spent, once.
    expect(await decideTurnEnd(turn({ state: { count: 2 } }))).toMatchObject({ rule: "local_paths" });
    expect(await decideTurnEnd(turn({ kind: "agents_dm" }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ bound: "stuck" }))).toMatchObject({ outcome: "done", rule: "stuck" });
  });

  test("only a reply about to be posted is held for its wording: after the judgment, never over a hold of its own", async () => {
    let judged = 0;
    const verdict = (v: "done" | "secret" | "unbacked" | "untried" | "continue" | "ask") => async () => {
      judged++;
      return v;
    };
    // Judged first: a secret asked in the chat, an unbacked claim or a give-up is held by its own rule.
    expect(await decideTurnEnd(turn({ verdict: verdict("secret") }))).toMatchObject({ rule: "secret" });
    expect(await decideTurnEnd(turn({ verdict: verdict("unbacked") }))).toMatchObject({ rule: "unbacked" });
    expect(await decideTurnEnd(turn({ verdict: verdict("untried") }))).toMatchObject({ rule: "untried" });
    // Past their own nudge they are posted as written, and still never held for their wording.
    const spent = { count: 3, secretNudged: true };
    expect(await decideTurnEnd(turn({ state: spent, verdict: verdict("secret") }))).toMatchObject({
      rule: "secret_cap",
    });
    expect(await decideTurnEnd(turn({ state: spent, verdict: verdict("unbacked") }))).toMatchObject({
      rule: "unbacked_cap",
    });
    expect(judged).toBe(5);
    // Posted otherwise (done, a promise, an ask): held, with the judgment already made, never a second one.
    judged = 0;
    expect(await decideTurnEnd(turn({ verdict: verdict("done") }))).toMatchObject({ rule: "local_paths" });
    expect(await decideTurnEnd(turn({ verdict: verdict("continue") }))).toMatchObject({ rule: "local_paths" });
    expect(await decideTurnEnd(turn({ verdict: verdict("ask") }))).toMatchObject({ rule: "local_paths" });
    expect(judged).toBe(3);
    // A turn with no words, a quiet one, a decision to report: nothing to hold.
    expect(await decideTurnEnd(turn({ quiet: true }))).toMatchObject({ rule: "quiet" });
    expect(await decideTurnEnd(turn({ unanswered: true, judged: "" }))).toMatchObject({ rule: "answer" });
    // Both rules on one reply: the path first.
    expect(await decideTurnEnd(turn({ namedTools: ["upload_file"] }))).toMatchObject({ rule: "local_paths" });
    expect(
      await decideTurnEnd(turn({ namedTools: ["upload_file"], state: { count: 0, pathsNudged: true } })),
    ).toMatchObject({ rule: "tool_names" });
  });
});

/** A computer that writes files and shares them: only the names and the scope matter here. */
const computer: ToolSource = {
  name: "computer",
  tools: async () =>
    ["write_file", "upload_file"].map((name) => ({
      name,
      description: name === "upload_file" ? "Share a file from your computer in this conversation." : "Write a file.",
      scope: "sandbox:run",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "done" }),
    })),
};

/** An agent with that computer, which writes `file` first, then replies `answer` (`rewrite` once told). */
const withComputer = async (file: string, answer: string, rewrite = answer) => {
  const fx = await setup({
    toolSources: [computer],
    reply: (request) => {
      if (lastUserText(request).startsWith("Not posted")) return { chunks: [rewrite] };
      if (JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")) return { chunks: [answer] };
      return { chunks: [], toolUses: [{ name: "write_file", input: { path: file, content: "Básico: US$ 9" } }] };
    },
  });
  await fx.db.insert(schema.agentScopes).values({ orgId: fx.org.id, agentId: fx.agent.id, scope: "sandbox:run" });
  return fx;
};

const lastUserText = (request: ModelRequest | undefined) => {
  const last = request?.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const agentBodies = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent" && !m.meta.notice)
    .map((m) => m.body);

const ask = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const nudged = async (fx: Fixture) =>
  (await fx.db.select().from(schema.agentRunSteps)).filter((s) => s.data.nudged === "local_paths").length;

describe("a run that cites one to people", () => {
  test("its reply is written again, and only that one is posted", async () => {
    const rewrite = "Pesquisei os planos: o Básico custa US$ 9 por mês e o Pro US$ 29.";
    f = await withComputer("notas/planos.md", "Pesquisei os planos e salvei o resumo em `notas/planos.md`.", rewrite);
    await ask(f, "@dev pesquisa os planos da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
    expect(lastUserText(f.provider.calls[2]?.request)).toContain(
      "Not posted: your reply cites files on your computer (`notas/planos.md`)",
    );
    expect(await agentBodies(f)).toEqual([rewrite]);
    expect(await nudged(f)).toBe(1);
  });

  test("a rewrite that still cites it is posted as written", async () => {
    const answer = "Salvei o resumo em `notas/planos.md`.";
    f = await withComputer("notas/planos.md", answer);
    await ask(f, "@dev pesquisa os planos da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
    expect(await agentBodies(f)).toEqual([answer]);
  });

  test("a path its computer never worked on is someone else's to open: posted as it is", async () => {
    const answer = "Achei no Drive: Marketing/Campanhas/briefing.docx.";
    f = await withComputer("notas/planos.md", answer);
    await ask(f, "@dev acha o briefing da campanha");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await agentBodies(f)).toEqual([answer]);
    expect(await nudged(f)).toBe(0);
  });

  test("its rewrite failing, the held reply is still the answer: posted, never lost", async () => {
    const answer = "Salvei o resumo em `notas/planos.md`.";
    f = await setup({
      toolSources: [computer],
      reply: (request) =>
        lastUserText(request).startsWith("Not posted")
          ? new ProviderError("overloaded", false, 529)
          : JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
            ? { chunks: [answer] }
            : { chunks: [], toolUses: [{ name: "write_file", input: { path: "notas/planos.md" } }] },
    });
    await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: f.agent.id, scope: "sandbox:run" });
    await ask(f, "@dev pesquisa os planos da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(await agentBodies(f)).toEqual([answer]);
  });

  test("a person who wrote the path, or an agent with no computer, gets the reply as it is", async () => {
    const answer = "Atualizei `notas/planos.md` com os preços de hoje.";
    f = await withComputer("notas/planos.md", answer);
    await ask(f, "@dev atualiza o notas/planos.md");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    await f.close();

    f = await setup({ reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev atualiza as notas dos planos");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    expect(await agentBodies(f)).toEqual([answer]);
  });

  test("a person who chose technical replies gets the path as it is", async () => {
    const answer = "Pronto: ~/out/dados.csv.";
    f = await withComputer("~/out/dados.csv", answer);
    await saveAgentStyle(f.db, f.org.id, f.owner.id, "technical");
    await ask(f, "@dev exporta os dados");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await agentBodies(f)).toEqual([answer]);
  });

  test("on a computer the person connected themselves, they can open the path: posted as it is", async () => {
    const answer = "Salvei a planilha em ~/Documents/planos.csv.";
    f = await withComputer("~/Documents/planos.csv", answer);
    const [mac] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "Mac da Ana", kind: "connected", pairedByUserId: f.owner.id })
      .returning();
    await f.db.update(schema.agents).set({ machineId: mac?.id }).where(eq(schema.agents.id, f.agent.id));
    await ask(f, "@dev monta a planilha dos planos");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await agentBodies(f)).toEqual([answer]);

    // Someone else's computer: the person can't open it.
    await f.db
      .update(schema.machines)
      .set({ pairedByUserId: null })
      .where(eq(schema.machines.id, mac?.id ?? ""));
    await ask(f, "@dev monta de novo");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(5);
  });

  test("on the server's own computer, its owner can't open the path either: written again", async () => {
    f = await withComputer("~/out/planos.csv", "Salvei a planilha em ~/out/planos.csv.");
    const [host] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "", kind: "host", pairedByUserId: f.owner.id })
      .returning();
    await f.db.update(schema.agents).set({ machineId: host?.id }).where(eq(schema.agents.id, f.agent.id));
    await ask(f, "@dev monta a planilha dos planos");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
    expect(await nudged(f)).toBe(1);
  });
});
