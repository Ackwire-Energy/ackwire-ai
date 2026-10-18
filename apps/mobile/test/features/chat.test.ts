import { describe, expect, test } from "bun:test";
import type { LiveConsult, LiveRun, Message } from "@agenteschat/client";
import {
  artifactsOf,
  buildRows,
  consultationsOf,
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
  routineAgents,
  standsAlone,
  stoppableInLine,
  threadFaces,
  threadRootsToLoad,
  threadTitleFrom,
  toggleReaction,
  workingEntries,
  workStepsOf,
} from "../../src/features/chat/logic";
import { at, message } from "./fixtures";

describe("timeline", () => {
  test("top-level messages and loaded thread replies, in time order, no duplicates", () => {
    const a = message({ id: "a", createdAt: at(10) });
    const b = message({ id: "b", createdAt: at(8), threadId: "a", author: { type: "agent", id: "dev" } });
    const c = message({ id: "c", createdAt: at(5) });
    expect(mergeTimeline([a, c], [[b, a]]).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("the agents' answers load for the latest person messages, not thread or mission roots", () => {
    const list = [
      message({ id: "p1" }),
      message({ id: "x", author: { type: "agent", id: "dev" } }),
      message({ id: "p2", meta: { missionStart: true } }),
      message({ id: "p3" }),
    ];
    expect(threadRootsToLoad(list, new Set(["p3"]))).toEqual(["p1"]);
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

  test("writing, failed and waiting runs leave the line (their rows say it)", () => {
    const entries = workingEntries(
      [
        run({ runId: "w", agentId: "atlas", status: "running", text: "Oi" }),
        run({ runId: "f", agentId: "ada", status: "failed" }),
        run({ runId: "a", agentId: "infra", status: "waiting_approval" }),
      ],
      [],
      name,
    );
    expect(entries).toEqual([]);
  });

  test("the tool step comes through (what it is doing, as on the web)", () => {
    const [e] = workingEntries([run({ runId: "r", agentId: "atlas", tool: "sentry_list_issues" })], [], name);
    expect(e?.activity).toEqual({ kind: "consulting", app: "Sentry" });
  });

  test("Parar: only real runs that are not writing yet", () => {
    const list = stoppableInLine([
      run({ runId: "p", agentId: "atlas", provisional: true }),
      run({ runId: "r", agentId: "atlas", status: "running" }),
      run({ runId: "w", agentId: "ada", status: "running", text: "Oi" }),
      run({ runId: "a", agentId: "infra", status: "waiting_approval" }),
    ]);
    expect(list.map((r) => r.runId)).toEqual(["r"]);
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
  const routineMeta = { routineId: "rt1", routine: { id: "rt1", name: "Erros do Sentry", runId: "x" } };

  test("the routine's top-level call is left out; only the agent's answer shows", () => {
    const call = message({ id: "call", body: "@atlas Verificar no Sentry…", meta: routineMeta, createdAt: at(10) });
    const answer = message({
      id: "ans",
      threadId: "call",
      author: { type: "agent", id: "atlas" },
      meta: { viaRoutine: { id: "rt1", name: "Erros do Sentry" } },
      createdAt: at(9),
    });
    const rows = buildRows([call, answer]);
    expect(rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.message.id : ""))).toEqual([
      "ans",
    ]);
  });

  test("a routine's message inside a thread shows with its own header: never grouped, nothing groups under it", () => {
    const before = message({ id: "a", threadId: "t", createdAt: at(10) });
    const routine = message({ id: "b", threadId: "t", meta: routineMeta, createdAt: at(9) });
    const after = message({ id: "c", threadId: "t", createdAt: at(8) });
    const rows = buildRows([before, routine, after]).flatMap((r) => (r.kind === "message" ? [r.grouped] : []));
    expect(rows).toEqual([false, false, false]);
    expect(standsAlone(routine)).toBe(true);
  });

  test("the agents it calls: known @handles, in order, once each", () => {
    const agents = [
      { handle: "atlas", name: "Atlas" },
      { handle: "ada", name: "Ada" },
    ];
    expect(routineAgents("@ada veja os issues; @Atlas e @ada, @nobody", agents).map((a) => a.name)).toEqual([
      "Ada",
      "Atlas",
    ]);
    expect(routineAgents("sem menção", agents)).toEqual([]);
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
  test("inline marks, links as text, mentions", () => {
    expect(parseInline("Oi @theo, veja **isto** e `npm i` em [docs](https://x)")).toEqual([
      { kind: "text", text: "Oi " },
      { kind: "mention", text: "@theo" },
      { kind: "text", text: ", veja " },
      { kind: "bold", text: "isto" },
      { kind: "text", text: " e " },
      { kind: "code", text: "npm i" },
      { kind: "text", text: " em docs" },
    ]);
    expect(parseInline("e-mail ana@x.com não é menção")).toEqual([
      { kind: "text", text: "e-mail ana@x.com não é menção" },
    ]);
  });
  test("blocks: paragraphs, lists, headings, quotes, code", () => {
    const blocks = parseBlocks(
      "# Título\nLinha um\nlinha dois\n\n- item\n2. outro\n> citação\n```ts\nconst a = 1;\n```",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "bullet", "bullet", "quote", "code"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", inline: [{ kind: "text", text: "Linha um\nlinha dois" }] });
    expect(blocks[3]).toMatchObject({ kind: "bullet", ordinal: "2" });
    expect(blocks[5]).toEqual({ kind: "code", text: "const a = 1;" });
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
    const rows = buildRows([message({ id: "p", author: { type: "agent", id: "dev" }, createdAt: at(11) }), asked]);
    expect(rows.filter((r) => r.kind === "message").map((r) => r.kind === "message" && r.grouped)).toEqual([
      false,
      false,
    ]);
  });
});
