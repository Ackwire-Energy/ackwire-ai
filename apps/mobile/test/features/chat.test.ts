import { describe, expect, test } from "bun:test";
import type { LiveConsult, LiveRun, Message, RunConsultation } from "@agenteschat/client";
import { consultBlocksNearEnd, consultsForLine } from "@agenteschat/client/lib/consult-group";
import { issueTakenOf, issueWorkOf } from "@agenteschat/client/lib/issues";
import { toolCalls, toolNow } from "@agenteschat/client/lib/work";
import {
  artifactsOf,
  buildRows,
  consultationsOf,
  eventLineOf,
  hidesBody,
  markedParts,
  markName,
  mayStopRun,
  mergeTimeline,
  missionCardRef,
  missionPlanOf,
  parseBlocks,
  parseInline,
  parseSlash,
  questionOf,
  reactionEmoji,
  reactionName,
  reactionPills,
  standsAlone,
  stoppableInLine,
  threadFaces,
  threadTitleFrom,
  toggleReaction,
  workingEntries,
  workStepsOf,
} from "../../src/features/chat/logic";
import {
  fadeTail,
  OPENERS,
  openingRuns,
  outputTail,
  pruneMarks,
  recentTurn,
  rememberTurn,
  stoppedOf,
  turnItems,
  turnOpener,
  turnPhase,
  turnRuns,
  withContinued,
  withOpacity,
} from "../../src/features/chat/turn";
import { at, message } from "./fixtures";

describe("timeline", () => {
  test("top-level messages and loaded thread replies, in time order, no duplicates", () => {
    const a = message({ id: "a", createdAt: at(10) });
    const b = message({ id: "b", createdAt: at(8), threadId: "a", author: { type: "agent", id: "dev" } });
    const c = message({ id: "c", createdAt: at(5) });
    expect(mergeTimeline([a, c], [[b, a]]).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("same author within 5 minutes groups; a day starts a new group; cards stand alone", () => {
    const rows = buildRows([
      message({ id: "1", createdAt: "2026-10-16T12:00:00.000Z" }),
      message({ id: "2", createdAt: "2026-10-17T12:00:00.000Z" }),
      message({ id: "3", createdAt: "2026-10-17T12:02:00.000Z" }),
      message({ id: "4", createdAt: "2026-10-17T12:03:00.000Z", meta: { approvalId: "ap1" } }),
      message({ id: "5", createdAt: "2026-10-17T12:04:00.000Z" }),
      message({ id: "6", createdAt: "2026-10-17T12:20:00.000Z" }),
    ]);
    const shape = rows.map((r) => (r.kind === "day" ? "day" : `${r.message.id}${r.grouped ? "+" : ""}`));
    expect(shape).toEqual(["day", "1", "day", "2", "3+", "4", "5", "6"]);
  });

  test("hidden messages leave no row", () => {
    const rows = buildRows([message({ id: "1" }), message({ id: "2", threadId: "t" })], (m) => m.threadId === "t");
    expect(rows.filter((r) => r.kind === "message")).toHaveLength(1);
  });
});

describe("what a message carries", () => {
  test("consultations, keeping only well-formed ones", () => {
    const meta = {
      consulted: [
        { agentId: "infra", consultationId: "k1", status: "answered", question: "Livre?", answer: "Livre." },
        { agentId: "infra", status: "answered", question: "E?", answer: "  " },
        { status: "answered" },
        "nope",
      ],
    };
    const list = consultationsOf(meta);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      agentId: "infra",
      consultationId: "k1",
      status: "answered",
      question: "Livre?",
      answer: "Livre.",
    });
    // Answered with nothing to show reads as "couldn't answer".
    expect(list[1]?.status).toBe("failed");
  });

  test("mission cards, plan, steps and files", () => {
    expect(missionCardRef({ missionReview: { id: "r1", missionId: "m1" } }, "missionReview")).toEqual({
      id: "r1",
      missionId: "m1",
    });
    expect(missionCardRef({ missionReview: { id: "r1" } }, "missionReview")).toBeNull();
    expect(missionPlanOf({ missionPlan: { missionId: "m1", title: "App", goal: "Fazer" } })).toEqual({
      missionId: "m1",
      title: "App",
      goal: "Fazer",
    });
    expect(workStepsOf({ work: { steps: 3, connectors: [] } })).toBe(3);
    expect(workStepsOf({ work: { steps: 0 } })).toBeNull();
    expect(
      artifactsOf({ artifacts: [{ id: "f1", version: 2, title: "Relatório" }, { id: "f2", deleted: true }, {}] }),
    ).toEqual([
      { id: "f1", version: 2, title: "Relatório", deleted: false },
      { id: "f2", title: "", deleted: true },
    ]);
  });
});

describe("working line", () => {
  const run = (over: Partial<LiveRun> & { runId: string; agentId: string }): LiveRun => ({
    channelId: "c1",
    threadId: "m1",
    status: "thinking",
    text: "",
    lastSeq: 0,
    ...over,
  });
  const names: Record<string, string> = { atlas: "Atlas", ada: "Ada", infra: "Infra" };
  const name = (id: string) => names[id] ?? id;

  test("one entry per agent: a provisional row plus the real run, or two runs, show one face", () => {
    const entries = workingEntries(
      [
        run({ runId: "pending:atlas:m1", agentId: "atlas", provisional: true }),
        run({ runId: "r1", agentId: "atlas", threadId: "m2", status: "running", tool: "sentry_list_issues" }),
        run({ runId: "r2", agentId: "ada" }),
      ],
      [],
      name,
    );
    expect(entries.map((e) => e.id)).toEqual(["atlas", "ada"]);
  });

  test("an agent asking another is one entry (with its consult), not also a working run", () => {
    const consult: LiveConsult = {
      runId: "r1",
      agentId: "atlas",
      consultedAgentId: "infra",
      channelId: "c1",
      threadId: "m1",
      status: "asking",
      since: 1,
      at: 1,
    };
    const entries = workingEntries([run({ runId: "r1", agentId: "atlas" })], [consult], name);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.consult).toMatchObject({ to: "infra", toName: "Infra", status: "asking" });
  });

  test("a question its reply shows near the end leaves the line; farther up, the line still says it", () => {
    const consult: LiveConsult = {
      runId: "r1",
      agentId: "atlas",
      consultedAgentId: "infra",
      channelId: "c1",
      threadId: "m1",
      status: "asking",
      since: 1,
      at: 1,
    };
    const asked: RunConsultation = {
      id: "q1",
      runId: "r1",
      agentId: "atlas",
      consultedAgentId: "infra",
      consultedRunId: "r-infra",
      status: "open",
      waiting: null,
      question: "Como está o deploy?",
      answer: null,
      createdAt: at(5),
      answeredAt: null,
      expiresAt: at(-10),
    };
    // The phone's rows: saved replies only (a turn at work doesn't show its questions yet).
    const reply = message({ id: "m-ask", author: { type: "agent", id: "atlas" }, agentRunId: "r1" });
    const near = consultBlocksNearEnd([message({ id: "m0" }), reply], [asked]);
    // Atlas at work on a new turn: its own entry, not the question.
    const entries = workingEntries([run({ runId: "r2", agentId: "atlas" })], consultsForLine([consult], near), name);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.consult).toBeUndefined();
    const far = consultBlocksNearEnd([reply, ...["a", "b", "c"].map((id) => message({ id }))], [asked]);
    expect(workingEntries([], consultsForLine([consult], far), name)[0]?.consult?.status).toBe("asking");
  });

  test("a writing agent stays on the line ('escrevendo'); failed and waiting runs leave it", () => {
    const entries = workingEntries(
      [
        run({ runId: "w", agentId: "atlas", status: "running", text: "Oi" }),
        run({ runId: "f", agentId: "ada", status: "failed" }),
        run({ runId: "a", agentId: "infra", status: "waiting_approval" }),
      ],
      [],
      name,
    );
    expect(entries.map((e) => [e.id, e.activity.kind])).toEqual([["atlas", "writing"]]);
  });

  test("the tool step comes through (what it is doing, as on the web)", () => {
    const [e] = workingEntries([run({ runId: "r", agentId: "atlas", tool: "sentry_list_issues" })], [], name);
    expect(e?.activity).toEqual({ kind: "consulting", app: "Sentry" });
  });

  test("Parar: real runs at work, also while they write (not a guess, not one waiting)", () => {
    const list = stoppableInLine([
      run({ runId: "p", agentId: "atlas", provisional: true }),
      run({ runId: "r", agentId: "atlas", status: "running" }),
      run({ runId: "w", agentId: "ada", status: "running", text: "Oi" }),
      run({ runId: "a", agentId: "infra", status: "waiting_approval" }),
      run({ runId: "s", agentId: "infra", status: "canceled", text: "Parei" }),
    ]);
    expect(list.map((r) => r.runId)).toEqual(["r", "w"]);
  });

  test("who may stop: admins, the agent's owner, or who sent the message that started it", () => {
    const r = run({ runId: "r", agentId: "atlas", triggerMessageId: "m1" });
    const messages = [message({ id: "m1", author: { type: "person", id: "me" } })];
    const base = { meId: "me", manageAgents: false, agentOwnerId: null, messages: [] as Message[] };
    expect(mayStopRun(r, base)).toBe(false);
    expect(mayStopRun(r, { ...base, manageAgents: true })).toBe(true);
    expect(mayStopRun(r, { ...base, agentOwnerId: "me" })).toBe(true);
    expect(mayStopRun(r, { ...base, messages })).toBe(true);
    expect(mayStopRun(r, { ...base, meId: "other", messages })).toBe(false);
  });

  test("names come back bold from the marked sentence", () => {
    expect(markedParts(`${markName("Atlas")} está trabalhando…`)).toEqual([
      { text: "Atlas", bold: true },
      { text: " está trabalhando…", bold: false },
    ]);
    expect(markedParts(`${markName("Theo")} e ${markName("Iris")}`)).toEqual([
      { text: "Theo", bold: true },
      { text: " e ", bold: false },
      { text: "Iris", bold: true },
    ]);
  });
});

describe("routine messages", () => {
  const atlas = { type: "agent" as const, id: "atlas" };
  const told = { routine: { id: "rt1", name: "Erros do Sentry", runId: "rr1", noticeId: "rep" } };

  test("a routine's call written as its creator is left out; only the agent's answer shows", () => {
    const call = message({ id: "call", body: "@atlas Verificar no Sentry…", meta: told, createdAt: at(10) });
    const answer = message({ id: "ans", threadId: "call", author: atlas, createdAt: at(9) });
    const rows = buildRows([call, answer]);
    expect(rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.message.id : ""))).toEqual([
      "ans",
    ]);
  });

  test("what a routine found stands alone with its own header; the report it answers folds into it", () => {
    const before = message({ id: "a", author: atlas, createdAt: at(10) });
    const report = message({
      id: "rep",
      author: atlas,
      meta: { notice: { kind: "routine_handoff", text: "3 erros", refs: { routineName: "Erros do Sentry" } } },
      createdAt: at(9),
    });
    const routine = message({ id: "b", author: atlas, meta: told, createdAt: at(8) });
    const after = message({ id: "c", author: atlas, createdAt: at(7) });
    const rows = buildRows([before, report, routine, after]).flatMap((r) =>
      r.kind === "message" ? [[r.message.id, r.grouped] as const] : [],
    );
    expect(rows).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
    ]);
    expect(standsAlone(routine)).toBe(true);
    // Without its answer, the report is still there, as its line.
    expect(buildRows([report]).filter((r) => r.kind === "message")).toHaveLength(1);
  });
});

describe("reactions", () => {
  test("👍 and 👎 travel by name", () => {
    expect(reactionEmoji("+1")).toBe("👍");
    expect(reactionName("👍")).toBe("+1");
    expect(reactionName("🎉")).toBe("🎉");
  });
  test("people's pills count people; agents show their faces; mine is marked", () => {
    const pills = reactionPills(
      [
        { reaction: "🎉", count: 1, userIds: [], agentIds: ["nina"] },
        { reaction: "+1", count: 2, userIds: ["me", "ana"] },
        { reaction: "👀", count: 0, userIds: [] },
      ],
      "me",
    );
    expect(pills).toEqual([
      { reaction: "🎉", emoji: "🎉", people: 0, agentIds: ["nina"], mine: false },
      { reaction: "+1", emoji: "👍", people: 2, agentIds: [], mine: true },
    ]);
  });
  test("toggling mine adds, removes and drops empty ones", () => {
    const on = toggleReaction([], "🙌", "me");
    expect(on).toEqual([{ reaction: "🙌", count: 1, userIds: ["me"], agentIds: [] }]);
    expect(toggleReaction(on, "🙌", "me")).toEqual([]);
    const shared = toggleReaction([{ reaction: "🙌", count: 1, userIds: ["ana"] }], "🙌", "me");
    expect(shared[0]?.userIds).toEqual(["ana", "me"]);
    expect(shared[0]?.count).toBe(2);
  });
});

describe("composer", () => {
  test("slash commands stay English identifiers", () => {
    expect(parseSlash("/mission Página de preços nova")).toEqual({ command: "mission", arg: "Página de preços nova" });
    expect(parseSlash("  /summary ")).toEqual({ command: "summary", arg: "" });
    expect(parseSlash("/missão x")).toBeNull();
    expect(parseSlash("/unknown")).toBeNull();
    expect(parseSlash("oi /mission")).toBeNull();
  });
  test("a thread's title from its first words", () => {
    expect(threadTitleFrom("Achei a causa: o Google mudou o endereço de retorno.")).toBe(
      "Achei a causa: o Google mudou",
    );
  });
  test("thread faces: distinct, known, at most two", () => {
    expect(
      threadFaces([
        { type: "person", id: "u1" },
        { type: "person", id: "u1" },
        { type: "agent", id: null },
        { type: "agent", id: "dev" },
        { type: "person", id: "u2" },
      ]),
    ).toEqual([
      { type: "person", id: "u1" },
      { type: "agent", id: "dev" },
    ]);
  });
});

describe("markdown", () => {
  test("inline marks, links, mentions", () => {
    expect(parseInline("Oi @theo, veja **isto** e `npm i` em [docs](https://x)")).toEqual([
      { kind: "text", text: "Oi " },
      { kind: "mention", text: "@theo" },
      { kind: "text", text: ", veja " },
      { kind: "bold", text: "isto" },
      { kind: "text", text: " e " },
      { kind: "code", text: "npm i" },
      { kind: "text", text: " em " },
      { kind: "link", text: "docs", href: "https://x" },
    ]);
    expect(parseInline("e-mail ana@x.com não é menção")).toEqual([
      { kind: "text", text: "e-mail ana@x.com não é menção" },
    ]);
  });
  test("bare addresses are links, without trailing punctuation; only web and e-mail open", () => {
    expect(parseInline("Aqui: https://github.com/acme/app/pull/76.")).toEqual([
      { kind: "text", text: "Aqui: " },
      { kind: "link", text: "https://github.com/acme/app/pull/76", href: "https://github.com/acme/app/pull/76" },
      { kind: "text", text: "." },
    ]);
    expect(parseInline("(veja https://x.com/a_b_c)")).toEqual([
      { kind: "text", text: "(veja " },
      { kind: "link", text: "https://x.com/a_b_c", href: "https://x.com/a_b_c" },
      { kind: "text", text: ")" },
    ]);
    expect(parseInline("[x](ftp://h) e ![logo](https://x/l.png) e `https://y`")).toEqual([
      { kind: "text", text: "x e logo e " },
      { kind: "code", text: "https://y" },
    ]);
  });
  test("blocks: paragraphs, lists, headings, quotes, code", () => {
    const blocks = parseBlocks(
      "# Título\nLinha um\nlinha dois\n\n- item\n2. outro\n> citação\n```ts\nconst a = 1;\n```",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "bullet", "bullet", "quote", "code"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", inline: [{ kind: "text", text: "Linha um\nlinha dois" }] });
    expect(blocks[3]).toMatchObject({ kind: "bullet", ordinal: "2" });
    expect(blocks[5]).toEqual({ kind: "code", lang: "ts", text: "const a = 1;" });
  });
  test("blocks: a fence still being written is an open code block; a fence still opening is hidden", () => {
    expect(parseBlocks('Aqui:\n```chart\n{"type":"bar","ti')).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "Aqui:" }] },
      { kind: "code", lang: "chart", text: '{"type":"bar","ti', open: true },
    ]);
    expect(parseBlocks("```ts\nconst a = 1;\n``").at(-1)).toEqual({
      kind: "code",
      lang: "ts",
      text: "const a = 1;",
      open: true,
    });
    expect(parseBlocks("Aqui:\n```cha")).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "Aqui:" }] }]);
    expect(parseBlocks("use `npm` e pronto `x`").map((b) => b.kind)).toEqual(["paragraph"]);
  });
  test("blocks: a table right under a sentence, with inline marks in cells and numbers aligned right", () => {
    const blocks = parseBlocks(
      "Usei a semana desde 18/10:\n| Gatilho | Exibições | Taxa |\n|---|---|---|\n| `generic` | 435 | ~6,7% |\nDepois.",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "paragraph"]);
    expect(blocks[1]).toEqual({
      kind: "table",
      header: [
        [{ kind: "text", text: "Gatilho" }],
        [{ kind: "text", text: "Exibições" }],
        [{ kind: "text", text: "Taxa" }],
      ],
      rows: [[[{ kind: "code", text: "generic" }], [{ kind: "text", text: "435" }], [{ kind: "text", text: "~6,7%" }]]],
      align: ["left", "right", "right"],
    });
  });
});

describe("an agent's question (ask_user)", () => {
  const question = {
    id: "q1",
    agentId: "dev",
    channelId: "c1",
    threadId: null,
    messageId: "m1",
    text: "Publico agora ou depois das 18h?",
    choices: ["Agora", "Depois das 18h", 3],
    status: "open",
    answer: null,
    answeredByUserId: null,
  };

  test("meta.question becomes the card's data; bad shapes are ignored", () => {
    expect(questionOf({ question })).toEqual({ ...question, choices: ["Agora", "Depois das 18h"] });
    expect(questionOf({ question: { ...question, choices: [] } })?.choices).toBeNull();
    expect(questionOf({ question: { ...question, status: "answered", answer: "Agora" } })).toMatchObject({
      status: "answered",
      answer: "Agora",
    });
    expect(questionOf({ question: { id: "q", text: "" } })).toBeNull();
    expect(questionOf({})).toBeNull();
    expect(questionOf(undefined)).toBeNull();
  });

  test("the question stands alone and its text is not repeated above the card", () => {
    const asked = message({
      id: "m1",
      author: { type: "agent", id: "dev" },
      body: "Publico agora ou depois das 18h?",
      meta: { question },
    });
    expect(hidesBody(asked)).toBe(true);
    expect(hidesBody({ ...asked, body: "Antes, uma pergunta." })).toBe(false);
    // An agent's proposal of a new agent is its card (ADR 0081); a Connect card, with no card here, keeps its text.
    const draft = { name: "Nina", handle: "nina", role: "", instructions: "x", appearance: null, channelIds: [] };
    const proposal = {
      kind: "agent_proposal",
      forUserId: null,
      params: { draft: { ...draft, access: [], ai: { kind: "none" } }, why: "x" },
      state: "pending",
      expiresAt: at(30),
    };
    expect(hidesBody(message({ id: "a1", author: { type: "agent", id: "dev" }, meta: { actionCard: proposal } }))).toBe(
      true,
    );
    const connect = { kind: "connect_ai", forUserId: null, params: { agentIds: [], why: "x" } };
    expect(hidesBody(message({ id: "a2", author: { type: "agent", id: "dev" }, meta: { actionCard: connect } }))).toBe(
      false,
    );
    const rows = buildRows([message({ id: "p", author: { type: "agent", id: "dev" }, createdAt: at(11) }), asked]);
    expect(rows.filter((r) => r.kind === "message").map((r) => r.kind === "message" && r.grouped)).toEqual([
      false,
      false,
    ]);
  });
});

describe("asking an agent to implement an issue", () => {
  const work = { issueId: "iss_1", number: 24, title: "Checkout quebra", agentId: "dev" };
  test("the DM thread's root is the issue card: no text, it stands alone", () => {
    const root = message({ id: "root", body: "Issue #24: Checkout quebra", meta: { issueWork: work } });
    expect(issueWorkOf(root.meta)).toEqual(work);
    expect(hidesBody(root)).toBe(true);
    expect(standsAlone(root)).toBe(true);
  });

  test("the line where the issue came from is its own row; anything else is not an issue line", () => {
    const line = message({
      id: "line",
      author: { type: "agent", id: "dev" },
      body: "Took issue #24: Checkout quebra",
      meta: { issueTaken: work, bodyCode: "issue_taken", bodyParams: { number: 24 } },
    });
    expect(issueTakenOf(line.meta)).toEqual(work);
    expect(standsAlone(line)).toBe(true);
    expect(issueTakenOf({ issueTaken: { issueId: "x" } })).toBeNull();
    expect(issueWorkOf(message({ id: "plain" }).meta)).toBeNull();
  });
});

describe("an agent's turn as one block", () => {
  const run = (over: Partial<LiveRun> & { runId: string }): LiveRun => ({
    agentId: "theo",
    channelId: "c1",
    threadId: "m1",
    status: "thinking",
    text: "",
    lastSeq: 0,
    ...over,
  });
  const call = (id: string, tool: string, running: boolean) => ({
    kind: "call" as const,
    id,
    tool,
    connector: null,
    detail: null,
    code: null,
    output: [],
    running,
  });

  test("the header word: thinking, working on steps, writing, stopped", () => {
    expect(turnPhase(run({ runId: "a" }))).toBe("thinking");
    expect(turnPhase(run({ runId: "b", tool: "sentry_list_issues" }))).toBe("working");
    expect(turnPhase(run({ runId: "c", work: [call("1", "sentry_list_issues", false)] }))).toBe("working");
    expect(turnPhase(run({ runId: "d", status: "running", text: "Ontem" }))).toBe("writing");
    expect(turnPhase(run({ runId: "e", status: "canceled", text: "Ontem" }))).toBe("stopped");
  });

  test("its work in order, as the tool block's items: calls (running or done), what it said, what it read", () => {
    const items = turnItems(
      run({
        runId: "r",
        work: [
          call("1", "sentry_list_issues", false),
          { kind: "say", text: "Vou ver o Drive", turn: 1 },
          { kind: "steer", messageId: "m2", now: true },
          call("2", "drive_read", true),
        ],
      }),
    );
    expect(items.map((x) => x.kind)).toEqual(["call", "say", "steer", "call"]);
    expect(items[0]).toMatchObject({ kind: "call", line: { state: "done", kind: "consulting", app: "Sentry" } });
    expect(items[2]).toMatchObject({ kind: "steer", messageId: "m2", now: true });
    expect(items[3]).toMatchObject({ kind: "call", line: { state: "run" } });
    expect(toolCalls(items)).toBe(2);
  });

  test("a reaction already shows on the message: a turn that only reacted has no block, other tools count alone", () => {
    expect(toolNow(turnItems(run({ runId: "r", status: "done", work: [call("1", "react", false)] })))).toBeNull();
    const items = turnItems(
      run({ runId: "r", work: [call("1", "mcp__agentes__react", false), call("2", "sentry_list_issues", false)] }),
    );
    expect(items.map((x) => (x.kind === "call" ? x.line.kind : x.kind))).toEqual(["consulting"]);
    expect(toolCalls(items)).toBe(1);
  });

  test("the same call again, nothing said between: one line counting both", () => {
    const items = turnItems(
      run({ runId: "r", work: [call("1", "sentry_list_issues", false), call("2", "sentry_list_issues", true)] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "call", line: { state: "run", count: 2 } });
  });

  test("it opens as if it had answered: a generic phrase, then the first thing it said", () => {
    const quiet = run({ runId: "r" });
    const generic = turnOpener(quiet, turnItems(quiet));
    expect(generic.said).toBeNull();
    expect(generic.opener).toBeGreaterThanOrEqual(0);
    expect(generic.opener).toBeLessThan(OPENERS);
    expect(turnOpener(quiet, []).opener).toBe(generic.opener);

    const said = run({
      runId: "r",
      work: [call("1", "sentry_list_issues", false), { kind: "say", text: "Vou pedir pro Josh", turn: 1 }],
    });
    const opened = turnOpener(said, turnItems(said));
    expect(opened).toMatchObject({ said: "Vou pedir pro Josh", opener: null });
    expect(opened.lines.map((x) => x.kind)).toEqual(["call"]);

    expect(turnOpener(run({ runId: "w", status: "running", text: "Ontem" }), []).opener).toBeNull();
    expect(turnOpener(run({ runId: "s", status: "canceled" }), []).opener).toBeNull();
  });

  test("one block at a time: the first at work, plus any stopped one (the order on screen never changes)", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b", text: "Ontem" }), run({ runId: "c", status: "canceled" })];
    expect(openingRuns(runs).map((r) => r.runId)).toEqual(["a", "c"]);
  });

  test("a stopped run's call that was running shows as stopped", () => {
    const items = turnItems(run({ runId: "r", status: "canceled", work: [call("1", "sentry_list_issues", true)] }));
    expect(items[0]).toMatchObject({ kind: "call", line: { state: "stop" } });
  });

  test("an open code line shows what it printed, its end when long", () => {
    expect(outputTail([{ text: "a\n" }, { text: "b" }])).toBe("a\nb");
    const long = outputTail([{ text: "x".repeat(50) }, { text: "end" }], 10);
    expect(long).toHaveLength(10);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("end")).toBe(true);
  });

  test("blocks: every run at work (a guess too) and a stopped one; one in its browser has its card", () => {
    const runs = [
      run({ runId: "p", provisional: true }),
      run({ runId: "q", status: "queued" }),
      run({ runId: "w", status: "running", text: "Oi" }),
      run({ runId: "s", status: "canceled", text: "Parei" }),
      run({ runId: "a", status: "waiting_approval" }),
      run({ runId: "f", status: "failed" }),
      run({ runId: "b", status: "running" }),
    ];
    expect(turnRuns(runs, new Set(["b"])).map((r) => r.runId)).toEqual(["p", "q", "w", "s"]);
  });

  test("words fade in: the newest pieces are the tail, the rest solid", () => {
    const text = "Ontem foram 1.284 visitas";
    // "Ontem " settled long ago, "foram " 140 ms ago, "1.284 " just now.
    const marks = [
      { at: 6, t: 0 },
      { at: 12, t: 860 },
      { at: 18, t: 1000 },
    ];
    const { solid, tail } = fadeTail(text, 18, marks, 1000);
    expect(solid).toBe(6);
    expect(tail.map((p) => p.text)).toEqual(["foram ", "1.284 "]);
    expect(tail[0]?.opacity).toBeCloseTo(0.5, 1);
    expect(tail[1]?.opacity).toBeCloseTo(0.05, 2);
    // Settled: everything is solid.
    expect(fadeTail(text, 18, marks, 2000)).toEqual({ solid: 18, tail: [] });
  });

  test("a tail with Markdown or a line break doesn't fade (it would read differently once parsed)", () => {
    const marks = [
      { at: 3, t: 0 },
      { at: 9, t: 1000 },
    ];
    expect(fadeTail("Oi **bom** dia", 9, marks, 1000)).toEqual({ solid: 9, tail: [] });
    expect(fadeTail("Oi\nbom dia", 9, marks, 1000)).toEqual({ solid: 9, tail: [] });
  });

  test("marks: the ones still fading plus the last settled one", () => {
    const marks = [
      { at: 3, t: 0 },
      { at: 6, t: 100 },
      { at: 9, t: 900 },
    ];
    expect(pruneMarks(marks, 1000)).toEqual([
      { at: 6, t: 100 },
      { at: 9, t: 900 },
    ]);
    expect(pruneMarks(marks, 100)).toEqual(marks);
  });

  test("the fading ink: hex gets an alpha, rgba is multiplied", () => {
    expect(withOpacity("#000000", 0.5)).toBe("#00000080");
    expect(withOpacity("rgba(10, 20, 30, 0.5)", 0.5)).toBe("rgba(10, 20, 30, 0.25)");
    expect(withOpacity("rgb(1, 2, 3)", 1)).toBe("rgba(1, 2, 3, 1)");
    expect(withOpacity("red", 0.5)).toBe("red");
  });

  test("the saved reply finds the work its block showed a moment ago", () => {
    const items = turnItems(run({ runId: "r9", work: [call("1", "sentry_list_issues", false)] }));
    rememberTurn("r9", { items, quotes: {}, at: 1000 });
    expect(recentTurn("r9", 2000)?.items).toEqual(items);
    expect(recentTurn("r9", 1000 + 60_000)).toBeNull();
    expect(recentTurn("nope", 2000)).toBeNull();
  });

  test("a stopped reply: who stopped it and whether it was continued", () => {
    expect(stoppedOf({ canceled: { byUserId: "u1" } })).toEqual({ byUserId: "u1", continuedRunId: null });
    expect(stoppedOf({ canceled: true })).toEqual({ byUserId: null, continuedRunId: null });
    expect(stoppedOf({})).toBeNull();
    const next = withContinued({ canceled: { byUserId: "u1", text: "Oi" }, other: 1 }, "r2");
    expect(next).toEqual({ canceled: { byUserId: "u1", text: "Oi", continuedRunId: "r2" }, other: 1 });
    expect(stoppedOf(next)?.continuedRunId).toBe("r2");
  });
});

describe("automatic lines (notices) and fast replies", () => {
  const handles: Record<string, string> = { infra: "Infra", dev: "Dev" };
  const names = { author: "Ada", agentByHandle: (handle: string) => handles[handle] ?? null };
  const agentMsg = (id: string, meta: Record<string, unknown>, over: Partial<Message> = {}) =>
    message({ id, author: { type: "agent", id: "ada" }, body: "", meta, ...over });

  test("a routine's report: «name» from the refs or `from`; the text on demand", () => {
    const own = eventLineOf(
      agentMsg("n1", {
        notice: { kind: "routine_handoff", text: "3 erros novos", refs: { routineName: "Sentry diário" } },
      }),
      names,
    );
    expect(own).toEqual({
      kind: "notice",
      icon: "clock",
      key: "chat.notice.routineHandoff",
      values: { routine: "Sentry diário" },
      text: "3 erros novos",
    });
    const fromOnly = eventLineOf(
      agentMsg("n2", { notice: { kind: "routine_handoff", text: "x", from: "Rotina «Bom dia»" } }),
      names,
    );
    expect(fromOnly?.values).toEqual({ routine: "Bom dia" });
    const anon = eventLineOf(agentMsg("n3", { notice: { kind: "routine_handoff", text: "x" } }), names);
    expect(anon?.key).toBe("chat.notice.routineHandoffAnon");
  });

  test("another agent's answer and note say its name, not the agent-facing handle (no @)", () => {
    const reply = eventLineOf(agentMsg("n1", { notice: { kind: "consult_reply", text: "ok", from: "@infra" } }), names);
    expect(reply).toMatchObject({ icon: "agent", key: "chat.notice.consultReply", values: { from: "Infra" } });
    const unknown = eventLineOf(
      agentMsg("n2", { notice: { kind: "agent_note", text: "ok", refs: { agentHandle: "@zed" } } }),
      names,
    );
    expect(unknown).toMatchObject({ icon: "chat", key: "chat.notice.agentNote", values: { from: "zed" } });
    const anon = eventLineOf(agentMsg("n3", { notice: { kind: "consult_reply", text: "ok" } }), names);
    expect(anon?.key).toBe("chat.notice.consultReplyAnon");
  });

  test("an agent's follow-up: when it will be back and for what, then the line that woke it", () => {
    // Today, so the line needs no day.
    const at = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
    const when = { time: (iso: string) => (iso === at ? "12:00" : "?"), locale: "pt-BR" };
    const refs = { runId: "r1", at, about: "ver o CI" };
    const set = eventLineOf(
      agentMsg("n1", { notice: { kind: "follow_up", text: "Check CI run 42", refs: { ...refs, state: "pending" } } }),
      names,
      when,
    );
    expect(set).toEqual({
      kind: "notice",
      icon: "clock",
      key: "chat.notice.followUp",
      values: { name: "Ada", about: "ver o CI", time: "12:00", day: "" },
      text: "Check CI run 42",
    });
    const canceled = eventLineOf(
      agentMsg("n2", { notice: { kind: "follow_up", text: "x", refs: { ...refs, state: "canceled" } } }),
      names,
      when,
    );
    expect(canceled?.key).toBe("chat.notice.followUpCanceled");
    const woke = eventLineOf(
      agentMsg("n3", { notice: { kind: "follow_up", text: "x", refs: { ...refs, wake: "1", followUpId: "n1" } } }),
      names,
      when,
    );
    expect(woke).toMatchObject({ key: "chat.notice.followUpWake", values: { name: "Ada", about: "ver o CI" } });
  });

  test("a wait's result names the agent that waited; the message's own text wins over the notice's", () => {
    const line = eventLineOf(
      agentMsg("n1", { notice: { kind: "wait_result", text: "notice text" } }, { body: "  o deploy terminou  " }),
      names,
    );
    expect(line).toMatchObject({
      icon: "check",
      key: "chat.notice.waitResult",
      values: { name: "Ada" },
      text: "o deploy terminou",
    });
    expect(eventLineOf(agentMsg("n2", { notice: { kind: "new_kind", text: "x" } }), names)).toMatchObject({
      icon: "bell",
      key: "chat.notice.other",
    });
  });

  test("a talker reply is the agent's message, never a line (it carries both meta.talker and a notice)", () => {
    const talker = agentMsg("t1", {
      talker: { runId: "r1", inReplyTo: "m1" },
      notice: { kind: "talker_reply", text: "Já vejo isso" },
    });
    expect(eventLineOf(talker, names)).toBeNull();
    expect(standsAlone(talker)).toBe(false);
  });

  test("a routine's firing written as its creator (before its own room) is never shown, nor a line", () => {
    const start = message({
      id: "bg",
      body: "@ada veja os erros",
      meta: { background: true, routineId: "rt1", routine: { id: "rt1", name: "Sentry diário" } },
    });
    expect(eventLineOf(start, names)).toBeNull();
    expect(buildRows([start]).filter((r) => r.kind === "message")).toHaveLength(0);
    expect(eventLineOf(message({ id: "plain" }), names)).toBeNull();
  });

  test("lines never group; a fast reply keeps its header (enquanto trabalha)", () => {
    const ada = { type: "agent" as const, id: "ada" };
    const rows = buildRows([
      message({ id: "a", author: ada, createdAt: at(10) }),
      message({ id: "n", author: ada, meta: { notice: { kind: "agent_note", text: "x" } }, createdAt: at(9) }),
      message({ id: "b", author: ada, createdAt: at(8) }),
      message({ id: "t", author: ada, meta: { talker: { runId: "r1" } }, createdAt: at(7) }),
      message({ id: "c", author: ada, createdAt: at(6) }),
    ]).flatMap((r) => (r.kind === "message" ? [r.grouped] : []));
    expect(rows).toEqual([false, false, false, false, true]);
  });
});
