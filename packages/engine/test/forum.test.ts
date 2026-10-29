import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  acceptForumSuggestion,
  addChannelMember,
  advanceForumTopic,
  ConflictError,
  cancelForumTopic,
  cancelRun,
  concludeForumTopic,
  createAgent,
  createForumIssues,
  createForumTopic,
  createIssue,
  createOrganization,
  createRoutine,
  dismissForumSuggestion,
  drainOutbox,
  ForbiddenError,
  getForumTopic,
  getIssueDetail,
  listArtifactVersions,
  listChannels,
  listForumTopics,
  listIssueActivity,
  NotFoundError,
  parseSuggestedIssues,
  parseSynthesis,
  passForumTurn,
  postInForumAsPerson,
  postPersonMessage,
  resumeForumTopic,
  runRoutineNow,
  setAgentAudience,
  splitStance,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SYNTHESIS = [
  "# Síntese",
  "## Decision",
  "Seguir com o plano B.",
  "",
  "## Pros and cons",
  "### @dev",
  "- Pro: rápido",
  "- Con: caro",
  "### @ops",
  "- Pro: seguro",
  "",
  "## Open questions",
  "- E o anual?",
  "",
  "## Next steps",
  "- @ops: medir a conversão — até sexta",
  "",
  "## Suggested issues",
  "- Medir a conversão — antes e depois da mudança",
  "- Atualizar a página de preços — com os novos valores",
].join("\n");

const SYNTHESIS_V2 = [
  "## Decision",
  "Seguir com o plano B, olhando o custo.",
  "",
  "## Suggested issues",
  "- Medir o custo — por mês",
  "",
  "## What changed",
  "- A decisão agora considera o custo",
].join("\n");

const PLAN = [
  "## Objective",
  "Captar leads pelo LinkedIn.",
  "## For the requester",
  "O botão fica ao lado do formulário.",
  "## In scope",
  "- Botão na landing",
  "- Empresa pelo domínio",
  "## Out of scope",
  "- Cargo",
  "## Steps",
  "1. Registrar o app — owner: @ops — size: ~½ dia",
  "2. Rota de OAuth — owner: @dev — after: 1 — size: ~1 dia",
  "3. Painel de conversão — owner: Ana — after: 2 — size: ~½ dia",
  "## Risks",
  "- Segredo no navegador",
  "## Metrics",
  "- Conversão antes e depois",
  "## Suggested issues",
  "- Registrar o app — no LinkedIn (step 1, owner: @ops)",
  "- Rota de OAuth — com PKCE (step 2, owner: @dev)",
].join("\n");

/** The text after the latest worker message in the model's input: a turn, or the synthesis. */
function lastAsk(req: ModelRequest) {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  const turn = last.lastIndexOf("your turn in round");
  const synthesis = last.lastIndexOf("now write the");
  return { last, isSynthesis: synthesis > turn, tail: last.slice(Math.max(turn, synthesis)) };
}

/**
 * Answers by role: a forum turn posts as the agent with a stance line (dev
 * proposes, the others disagree with dev); the synthesis turn writes the
 * synthesis (or the plan, or version 2).
 */
function forumReply(onTurn?: (handle: string, req: ModelRequest) => void) {
  return (req: ModelRequest) => {
    const handle = /\(@([a-z0-9_-]+)\)/.exec(systemText(req.system ?? ""))?.[1] ?? "?";
    const { last, isSynthesis, tail } = lastAsk(req);
    if (last.includes("tool_result")) return { chunks: ["Feito."] };
    if (last.includes("leva isso pro fórum")) {
      return {
        chunks: [],
        toolUses: [
          {
            name: "open_forum_topic",
            input: { title: "Preços do Q1", goal: "Decidir o plano de entrada.", agents: ["dev"], max_rounds: 1 },
          },
        ],
      };
    }
    if (last.includes("vale um fórum")) {
      return {
        chunks: [],
        toolUses: [
          {
            name: "suggest_forum_topic",
            input: {
              title: "Link mágico?",
              goal: "Trocar a senha por link.",
              agents: ["dev"],
              rounds: 2,
              format: "plan",
            },
          },
        ],
      };
    }
    if (isSynthesis) {
      if (tail.includes("version 2")) return { chunks: [SYNTHESIS_V2] };
      return { chunks: [tail.includes("now write the plan") ? PLAN : SYNTHESIS] };
    }
    onTurn?.(handle, req);
    const header =
      handle === "dev" ? "Stance: proposes\nPosition: Plano B" : "Stance: disagrees @dev\nReplying to: @dev";
    return { chunks: [`${header}\n\n${handle} acha que sim; @ops, o que você acha?`] };
  };
}

async function twoAgents(reply = forumReply()) {
  f = await setup({ reply, artifactTools: true, forumTools: true });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  return { ops };
}

const forum = () => ({ db: f.db, pubsub: f.pubsub, artifacts: f.artifactDeps });
const runs = async () => f.db.select().from(schema.agentRuns);
const open = (input: Partial<Parameters<typeof createForumTopic>[3]> & { agentIds: string[] }) =>
  createForumTopic(forum(), { type: "person", userId: f.owner.id }, f.org.id, {
    title: "Plano de preços",
    goal: "Decidir o plano de entrada.",
    ...input,
  });
const topicOf = (id: string) => getForumTopic(f.db, f.owner.id, f.org.id, id);
const statuses = (t: Awaited<ReturnType<typeof topicOf>>, round: number) =>
  t.track.rounds.find((r) => r.round === round)?.entries.map((e) => e.status);

describe("rounds", () => {
  test("one run per agent per round, in order, up to the limit; then the synthesis as a Drive document", async () => {
    const { ops } = await twoAgents();
    const topic = await open({ agentIds: [f.agent.id, ops.id], rounds: 2 });
    expect(topic).toMatchObject({
      status: "open",
      rounds: 2,
      format: "decision",
      agentIds: [f.agent.id, ops.id],
      userIds: [f.owner.id],
      seats: [
        { type: "agent", id: f.agent.id },
        { type: "agent", id: ops.id },
      ],
      responsibleUserId: f.owner.id,
      origin: { kind: "direct" },
    });
    expect(topic).not.toHaveProperty("budgetUsedPercent");
    await drainOutbox(f.db, f.handlers);

    const done = await topicOf(topic.id);
    expect(done.status).toBe("done");
    const discussion = done.posts.filter((p) => !p.meta?.synthesis);
    expect(discussion.map((p) => [p.round, p.author.id])).toEqual([
      [1, f.agent.id],
      [1, ops.id],
      [2, f.agent.id],
      [2, ops.id],
    ]);
    // Mentions between agents start nobody: exactly 4 turns + 1 synthesis.
    const all = await runs();
    expect(all).toHaveLength(5);
    expect(all.every((r) => r.trigger === "forum" && r.channelId === topic.channelId)).toBe(true);
    expect(f.provider.calls).toHaveLength(5);
    // The track: every seat spoke in both rounds; the synthesis is written.
    expect(statuses(done, 1)).toEqual(["spoke", "spoke"]);
    expect(statuses(done, 2)).toEqual(["spoke", "spoke"]);
    expect(done.track.synthesis).toMatchObject({ status: "done", agentId: f.agent.id, revision: 1 });
    // The synthesis: a document in the Drive, with the suggested issues and the cards.
    expect(done.synthesis?.suggestedIssues).toEqual([
      { title: "Medir a conversão", description: "antes e depois da mudança" },
      { title: "Atualizar a página de preços", description: "com os novos valores" },
    ]);
    expect(done.synthesis).toMatchObject({ revision: 1, format: "decision", version: 1 });
    expect(done.synthesis?.structured).toMatchObject({
      format: "decision",
      decision: "Seguir com o plano B.",
      positions: [
        { agentId: f.agent.id, name: "dev", pros: ["rápido"], cons: ["caro"] },
        { agentId: ops.id, name: "ops", pros: ["seguro"], cons: [] },
      ],
      openQuestions: ["E o anual?"],
      nextSteps: [{ text: "medir a conversão", owner: { type: "agent", id: ops.id }, when: "até sexta" }],
    });
    const [artifact] = await f.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, done.synthesis?.artifactId ?? ""));
    expect(artifact).toMatchObject({ kind: "document", title: "Synthesis: Plano de preços" });
    // Issues only when a person approves them.
    const { numbers } = await createForumIssues(
      forum(),
      f.owner.id,
      f.org.id,
      topic.id,
      done.synthesis?.suggestedIssues ?? [],
    );
    expect(numbers).toHaveLength(2);
    expect((await topicOf(topic.id)).synthesis?.createdIssues.map((i) => i.number)).toEqual(numbers);
    // The forum channel is not a chat channel.
    expect((await listChannels(f.db, f.owner.id, f.org.id)).map((c) => c.id)).not.toContain(topic.channelId);
    await expect(
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, topic.channelId, { body: "oi" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("stances: the header line becomes the post's stance, reply and position, out of the body", async () => {
    const { ops } = await twoAgents();
    const topic = await open({ agentIds: [f.agent.id, ops.id], rounds: 1 });
    await drainOutbox(f.db, f.handlers);
    const [dev, op] = (await topicOf(topic.id)).posts.filter((p) => p.kind === "turn");
    expect(dev).toMatchObject({ stance: { kind: "propose" }, position: "Plano B", replyTo: null });
    expect(dev?.body).toBe("dev acha que sim; @ops, o que você acha?");
    expect(op).toMatchObject({
      stance: { kind: "disagree", target: { type: "agent", id: f.agent.id, handle: "dev" } },
      replyTo: dev?.id,
    });
    expect(op?.body.startsWith("Stance")).toBe(false);
  });

  test("an agent out of its own budget skips its turn (before the run, or when the run hits it); no topic cap", async () => {
    const { ops } = await twoAgents();
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    // ops has nothing left; qa has one nano-dollar: its run fails at the gateway.
    await f.db.update(schema.agents).set({ monthlyBudgetNanoUsd: 0 }).where(eq(schema.agents.id, ops.id));
    await f.db.update(schema.agents).set({ monthlyBudgetNanoUsd: 1 }).where(eq(schema.agents.id, qa.id));
    const topic = await open({ agentIds: [f.agent.id, ops.id, qa.id], rounds: 1 });
    await drainOutbox(f.db, f.handlers);
    const done = await topicOf(topic.id);
    expect(done.status).toBe("done");
    expect(statuses(done, 1)).toEqual(["spoke", "skipped_budget", "skipped_budget"]);
    // dev, qa (failed on its budget) and the synthesis; ops never ran.
    const all = await runs();
    expect(all.map((r) => r.agentId)).toEqual([f.agent.id, qa.id, f.agent.id]);
    expect(all.find((r) => r.agentId === qa.id)).toMatchObject({ status: "failed", error: "budget_exceeded" });
    expect(done.synthesis?.revision).toBe(1);
  });

  test("an agent that thinks with Claude Code on a computer keeps its turn with its budget out", async () => {
    const { ops } = await twoAgents();
    await f.db
      .update(schema.agents)
      .set({ monthlyBudgetNanoUsd: 0, brain: "claude_code" })
      .where(eq(schema.agents.id, ops.id));
    const topic = await open({ agentIds: [f.agent.id, ops.id], rounds: 1 });
    await drainOutbox(f.db, f.handlers);
    // Not skipped before the run: its turn goes to the computer (the plan, not the budget).
    const all = await runs();
    expect(all.some((r) => r.agentId === ops.id)).toBe(true);
    expect((await topicOf(topic.id)).status).toBe("done");
  });

  test("a person's post ends the round early and leads the next; Concluir stops after the current turn", async () => {
    let lastPrompt = "";
    const { ops } = await twoAgents(
      forumReply((_handle, req) => {
        lastPrompt = JSON.stringify(req.messages);
      }),
    );
    const topic = await open({ title: "Onboarding", goal: "Achar o que trava.", agentIds: [f.agent.id, ops.id] });
    await drainOutbox(f.db, f.handlers, { maxBatches: 2 }); // start + dev's round-1 turn
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id]);
    const post = await postInForumAsPerson(forum(), f.owner.id, f.org.id, topic.id, "Lembrem do custo do PC.");
    expect(post).toMatchObject({ round: 1, kind: "free" });
    await drainOutbox(f.db, f.handlers, { maxBatches: 2 });
    // ops' round-1 turn was skipped: the person's post leads round 2, which dev reads.
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id, f.agent.id]);
    expect(lastPrompt).toContain("Lembrem do custo do PC.");
    const mid = await topicOf(topic.id);
    expect(mid.track.rounds[1]?.personPosts).toEqual([{ userId: f.owner.id, postId: post.id, length: 23 }]);
    await concludeForumTopic(forum(), f.owner.id, f.org.id, topic.id);
    await drainOutbox(f.db, f.handlers);
    const done = await topicOf(topic.id);
    expect(done.status).toBe("done");
    expect((await runs()).length).toBe(3); // dev r1, dev r2, synthesis
    expect(statuses(done, 1)).toEqual(["spoke", "skipped"]);
  });

  test("at the last round, a person's post with requestRound adds one round instead of the synthesis", async () => {
    const { ops } = await twoAgents();
    const topic = await open({ agentIds: [f.agent.id, ops.id], rounds: 1 });
    await drainOutbox(f.db, f.handlers, { maxBatches: 2 }); // dev's round-1 turn
    await postInForumAsPerson(forum(), f.owner.id, f.org.id, topic.id, "Mais uma, por favor.", { requestRound: {} });
    await drainOutbox(f.db, f.handlers);
    const done = await topicOf(topic.id);
    expect(done.rounds).toBe(2);
    // dev r1, then round 2 from the post (dev, ops), then the synthesis.
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id, f.agent.id, ops.id, f.agent.id]);
  });
});

describe("the table", () => {
  test("a seated person's turn waits for them: their post is the turn; they can pass", async () => {
    const { ops } = await twoAgents();
    const topic = await open({
      agentIds: [f.agent.id, ops.id],
      rounds: 2,
      seats: [
        { type: "agent", id: f.agent.id },
        { type: "person", id: f.owner.id },
        { type: "agent", id: ops.id },
      ],
    });
    expect(topic.seats.map((s) => s.type)).toEqual(["agent", "person", "agent"]);
    await drainOutbox(f.db, f.handlers);
    let t = await topicOf(topic.id);
    expect(t).toMatchObject({ status: "open", phase: "waiting_person", waitingUserId: f.owner.id, round: 1 });
    expect(statuses(t, 1)).toEqual(["spoke", "waiting", "pending"]);
    // Only the person whose turn it is can pass.
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await expect(passForumTurn(forum(), bob.id, f.org.id, topic.id)).rejects.toBeInstanceOf(ValidationError);

    const seat = await postInForumAsPerson(forum(), f.owner.id, f.org.id, topic.id, "Eu topo o plano B.");
    expect(seat.kind).toBe("seat");
    await drainOutbox(f.db, f.handlers);
    t = await topicOf(topic.id);
    // ops r1, dev r2, then the person's round-2 turn.
    expect(t).toMatchObject({ phase: "waiting_person", round: 2 });
    expect(statuses(t, 1)).toEqual(["spoke", "spoke", "spoke"]);
    await passForumTurn(forum(), f.owner.id, f.org.id, topic.id);
    await drainOutbox(f.db, f.handlers);
    t = await topicOf(topic.id);
    expect(t.status).toBe("done");
    expect(statuses(t, 2)).toEqual(["spoke", "passed", "spoke"]);
    // A seated post is not a priority post: no round ended early.
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id, ops.id, f.agent.id, ops.id, f.agent.id]);
  });

  test("with a deadline, the discussion goes on without the seated person when it passes", async () => {
    const { ops } = await twoAgents();
    const deadline = new Date(Date.now() + 3_600_000);
    const topic = await open({
      agentIds: [f.agent.id, ops.id],
      rounds: 2,
      deadline,
      seats: [
        { type: "person", id: f.owner.id },
        { type: "agent", id: f.agent.id },
        { type: "agent", id: ops.id },
      ],
    });
    await drainOutbox(f.db, f.handlers);
    expect((await topicOf(topic.id)).phase).toBe("waiting_person");
    // Before the deadline nothing moves; after it, the turn is skipped and the synthesis comes.
    expect(await advanceForumTopic(forum(), topic.id)).toBe("none");
    expect(await advanceForumTopic(forum(), topic.id, new Date(deadline.getTime() + 1000))).toBe("synthesis");
    await drainOutbox(f.db, f.handlers);
    const done = await topicOf(topic.id);
    expect(done.status).toBe("done");
    expect(statuses(done, 1)?.[0]).toBe("skipped");
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id]); // only the synthesis
  });

  test("stopping the current turn leaves the topic stalled until someone resumes it", async () => {
    const { ops } = await twoAgents();
    const topic = await open({ agentIds: [f.agent.id, ops.id], rounds: 1 });
    await drainOutbox(f.db, f.handlers, { maxBatches: 1 }); // dev's turn is queued
    const [run] = await runs();
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run?.id ?? "");
    await drainOutbox(f.db, f.handlers);
    let t = await topicOf(topic.id);
    expect(t.status).toBe("stalled");
    expect(t.stall).toMatchObject({ reason: "stopped", byUserId: f.owner.id, agentId: f.agent.id, synthesis: false });
    expect(statuses(t, 1)).toEqual(["stopped", "pending"]);
    expect(await runs()).toHaveLength(1); // nobody talks while stalled

    await resumeForumTopic(forum(), f.owner.id, f.org.id, topic.id);
    await drainOutbox(f.db, f.handlers);
    t = await topicOf(topic.id);
    expect(t.status).toBe("done");
    expect(statuses(t, 1)).toEqual(["spoke", "spoke"]);
    // The stopped turn started again: dev (stopped), dev, ops, synthesis.
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id, f.agent.id, ops.id, f.agent.id]);
    await expect(resumeForumTopic(forum(), f.owner.id, f.org.id, topic.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("after the synthesis", () => {
  test("a comment stays a comment; a new round from a comment reopens it and rewrites the synthesis as version 2", async () => {
    const { ops } = await twoAgents();
    const topic = await open({ agentIds: [f.agent.id, ops.id], rounds: 1 });
    await drainOutbox(f.db, f.handlers);
    const v1 = await topicOf(topic.id);
    expect(v1.synthesis).toMatchObject({ revision: 1, version: 1 });

    const comment = await postInForumAsPerson(forum(), f.owner.id, f.org.id, topic.id, "Bom resumo.");
    expect(comment.kind).toBe("comment");
    await drainOutbox(f.db, f.handlers);
    expect((await topicOf(topic.id)).status).toBe("done");
    expect(await runs()).toHaveLength(3);

    await postInForumAsPerson(forum(), f.owner.id, f.org.id, topic.id, "E o custo?", {
      requestRound: { agentIds: [ops.id] },
    });
    const reopened = await topicOf(topic.id);
    expect(reopened).toMatchObject({ status: "open", reopened: { byUserId: f.owner.id }, rounds: 2 });
    await drainOutbox(f.db, f.handlers);

    const v2 = await topicOf(topic.id);
    expect(v2.status).toBe("done");
    expect(v2.reopened).toBeNull();
    // Only ops answered in round 2, then dev rewrote the synthesis.
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id, ops.id, f.agent.id, ops.id, f.agent.id]);
    expect(statuses(v2, 2)).toEqual(["skipped", "spoke"]);
    // The same Drive document, version 2; version 1 stays retrievable.
    expect(v2.synthesis).toMatchObject({ artifactId: v1.synthesis?.artifactId, version: 2, revision: 2 });
    expect(v2.synthesis?.structured?.changes).toEqual(["A decisão agora considera o custo"]);
    expect(v2.synthesis?.versions.map((v) => v.revision)).toEqual([1, 2]);
    expect(v2.syntheses.map((s) => s.structured.format)).toEqual(["decision", "decision"]);
    const versions = await listArtifactVersions(
      f.artifactDeps,
      { type: "person", userId: f.owner.id },
      f.org.id,
      v1.synthesis?.artifactId ?? "",
    );
    expect(versions).toHaveLength(2);
  });

  test("a plan: structured steps with owners and dependencies, issues per step", () => {
    const resolve = (label: string) =>
      label === "@ops"
        ? ({ type: "agent", id: "ops-id" } as const)
        : label === "Ana"
          ? ({ type: "person", id: "ana-id" } as const)
          : null;
    const plan = parseSynthesis("plan", PLAN, resolve);
    expect(plan).toMatchObject({
      format: "plan",
      objective: "Captar leads pelo LinkedIn.",
      summaryForRequester: "O botão fica ao lado do formulário.",
      inScope: ["Botão na landing", "Empresa pelo domínio"],
      outOfScope: ["Cargo"],
      risks: ["Segredo no navegador"],
      metrics: ["Conversão antes e depois"],
      steps: [
        { title: "Registrar o app", owner: { type: "agent", id: "ops-id" }, after: null, size: "~½ dia" },
        { title: "Rota de OAuth", owner: null, ownerLabel: "@dev", after: 1, size: "~1 dia" },
        { title: "Painel de conversão", owner: { type: "person", id: "ana-id" }, after: 2 },
      ],
      suggestedIssues: [
        { title: "Registrar o app", description: "no LinkedIn", step: 1, owner: { type: "agent", id: "ops-id" } },
        { title: "Rota de OAuth", description: "com PKCE", step: 2, owner: null },
      ],
    });
    expect(parseSynthesis("decision", "Só um parágrafo.").format).toBe("decision");
    // The decision stays one sentence: the reasons have their own section, or come from a list written under it.
    expect(
      parseSynthesis("decision", "## Decision\nSeguir com A.\n\n## Why\n- é barato\n- `pdfExported` fica"),
    ).toMatchObject({
      reasons: ["é barato", "`pdfExported` fica"],
    });
    expect(
      parseSynthesis("decision", "## Decision\nSeguir com A. Motivos:\n- 5 negativos\n- fácil de reverter"),
    ).toMatchObject({ decision: "Seguir com A. Motivos:", reasons: ["5 negativos", "fácil de reverter"] });
  });
});

describe("from issues, the chat and routines", () => {
  test("Avaliar no fórum: a plan for an issue comes back to it; its issues become sub-issues", async () => {
    const { ops } = await twoAgents();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: bob.id }, f.org.id, {
      title: "Captar lead pelo LinkedIn",
    });
    const topic = await open({
      title: "Como captar lead pelo LinkedIn?",
      agentIds: [f.agent.id, ops.id],
      rounds: 1,
      format: "plan",
      origin: { kind: "issue", issueId: issue.id },
    });
    expect(topic).toMatchObject({
      format: "plan",
      origin: { kind: "issue", issueId: issue.id, issueNumber: issue.number },
      requestedByUserId: bob.id,
      responsibleUserId: f.owner.id,
    });
    const person = { type: "person" as const, userId: f.owner.id };
    expect((await listIssueActivity(f.db, person, f.org.id, issue.id)).map((a) => a.event)).toContain("forum_opened");
    await drainOutbox(f.db, f.handlers);

    const done = await topicOf(topic.id);
    expect(done.synthesis?.structured).toMatchObject({ format: "plan", objective: "Captar leads pelo LinkedIn." });
    const [artifact] = await f.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, done.synthesis?.artifactId ?? ""));
    expect(artifact?.title).toBe("Plan: Como captar lead pelo LinkedIn?");
    const activity = await listIssueActivity(f.db, person, f.org.id, issue.id);
    const evaluated = activity.find((a) => a.event === "forum_evaluated");
    expect(evaluated).toMatchObject({ textCode: "forum_evaluated", textParams: { topicId: topic.id } });
    const comment = activity.find((a) => a.kind === "comment");
    expect(comment?.text).toContain(`/forum/${topic.id}`);
    expect(comment?.text).toContain("O botão fica ao lado do formulário.");

    const created = await createForumIssues(
      forum(),
      f.owner.id,
      f.org.id,
      topic.id,
      done.synthesis?.suggestedIssues ?? [],
    );
    const detail = await getIssueDetail(f.db, person, f.org.id, { id: issue.id });
    expect(detail.subIssues.map((s) => s.number)).toEqual(created.numbers);
    expect(detail.subIssues[0]?.assignee).toEqual({ type: "agent", id: ops.id });
    expect(detail.forumTopics).toEqual([{ id: topic.id, title: topic.title, status: "done", format: "plan" }]);
    expect(detail.artifacts.map((a) => a.id)).toContain(done.synthesis?.artifactId ?? "missing");
  });

  test("@dev leva isso pro fórum: the tool opens it; the synthesis comes back where it was asked", async () => {
    f = await setup({ reply: forumReply(), artifactTools: true, forumTools: true });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev leva isso pro fórum: qual plano de entrada?",
    });
    await drainOutbox(f.db, f.handlers);
    const [topic] = await listForumTopics(f.db, f.owner.id, f.org.id);
    expect(topic).toMatchObject({
      title: "Preços do Q1",
      status: "done",
      originChannelId: f.general.id,
      createdBy: { type: "agent", id: f.agent.id },
      origin: { kind: "agent", agentId: f.agent.id },
    });
    const back = (await f.db.select().from(schema.messages)).find((m) => m.meta.forumTopicId === topic?.id);
    // Asked in the channel, with no thread under the message: back in the channel.
    expect(back).toMatchObject({ channelId: f.general.id, threadId: null, authorAgentId: f.agent.id });
    expect(back?.meta.artifacts).toEqual([{ id: topic?.synthesis?.artifactId, version: 1 }]);
  });

  test("an agent suggests a topic; only a person opens it (or dismisses it)", async () => {
    f = await setup({ reply: forumReply(), artifactTools: true, forumTools: true });
    // One after the other (both at once would be one run: the second joins the first while it works).
    for (const body of ["@dev vale um fórum?", "@dev vale um fórum sobre isso?"]) {
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
      await drainOutbox(f.db, f.handlers);
    }
    // The cards are in the conversation; no topic exists yet.
    expect(await listForumTopics(f.db, f.owner.id, f.org.id)).toEqual([]);
    const cards = (await f.db.select().from(schema.messages)).filter((m) => m.meta.forumSuggestion);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.meta.forumSuggestion).toMatchObject({
      title: "Link mágico?",
      agentIds: [f.agent.id],
      rounds: 2,
      format: "plan",
      state: "pending",
      suggestedByAgentId: f.agent.id,
    });
    const [first, second] = cards;

    const { topic, suggestion } = await acceptForumSuggestion(forum(), f.owner.id, f.org.id, first?.id ?? "");
    expect(topic).toMatchObject({
      title: "Link mágico?",
      format: "plan",
      rounds: 2,
      createdBy: { type: "person", id: f.owner.id },
      responsibleUserId: f.owner.id,
      origin: { kind: "suggestion", agentId: f.agent.id, channelId: f.general.id },
    });
    expect(suggestion).toMatchObject({ state: "accepted", topicId: topic.id, decidedByUserId: f.owner.id });
    await expect(acceptForumSuggestion(forum(), f.owner.id, f.org.id, first?.id ?? "")).rejects.toBeInstanceOf(
      ConflictError,
    );
    const dismissed = await dismissForumSuggestion(forum(), f.owner.id, f.org.id, second?.id ?? "");
    expect(dismissed.suggestion.state).toBe("dismissed");
    await expect(acceptForumSuggestion(forum(), f.owner.id, f.org.id, second?.id ?? "")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await listForumTopics(f.db, f.owner.id, f.org.id)).toHaveLength(1);
    // Someone outside the conversation can't open it.
    const zed = await addMember(f.db, f.org.id, "member", "zed");
    await expect(dismissForumSuggestion(forum(), zed.id, f.org.id, second?.id ?? "")).rejects.toThrow();
  });

  test("a routine opens a topic on its schedule", async () => {
    const { ops } = await twoAgents();
    const routineDeps = { db: f.db, pubsub: f.pubsub, context: f.context, artifacts: f.artifactDeps };
    const routine = await createRoutine(routineDeps, f.owner.id, f.org.id, {
      name: "Retrospectiva",
      agentId: f.agent.id,
      prompt: "O que deu certo e o que não deu nesta semana?",
      target: { type: "forum", agentIds: [ops.id], rounds: 1 },
      trigger: { type: "schedule", phrase: "toda sexta às 17h" },
    });
    await runRoutineNow(routineDeps, f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const [topic] = await listForumTopics(f.db, f.owner.id, f.org.id);
    expect(topic?.title.startsWith("Retrospectiva · ")).toBe(true);
    expect(topic?.goal).toBe("O que deu certo e o que não deu nesta semana?");
    expect(topic?.agentIds.sort()).toEqual([f.agent.id, ops.id].sort());
    expect(topic?.status).toBe("done");
    expect(topic?.origin).toMatchObject({ kind: "routine", routineId: routine.id });
  });
});

describe("permissions", () => {
  test("audience, who can stop it, and other organizations", async () => {
    const { ops } = await twoAgents();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    await f.db.update(schema.agents).set({ ownerUserId: f.owner.id }).where(eq(schema.agents.id, ops.id));
    await setAgentAudience(f.db, f.owner.id, f.org.id, ops.id, { mode: "owner", userIds: [] });
    await expect(
      createForumTopic(forum(), { type: "person", userId: bob.id }, f.org.id, {
        title: "x",
        goal: "y",
        agentIds: [ops.id],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const topic = await open({ title: "Só nosso", goal: "Algo.", agentIds: [f.agent.id], rounds: 1 });
    // Everyone reads the forum; only who opened it, participants or admins stop it.
    expect((await getForumTopic(f.db, bob.id, f.org.id, topic.id)).title).toBe("Só nosso");
    await expect(cancelForumTopic(forum(), bob.id, f.org.id, topic.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await cancelForumTopic(forum(), f.owner.id, f.org.id, topic.id)).status).toBe("canceled");
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(0); // canceled before its first turn

    const zed = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, zed.id, { name: "Outra" });
    expect(await listForumTopics(f.db, zed.id, organization.id)).toEqual([]);
    await expect(getForumTopic(f.db, zed.id, organization.id, topic.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("synthesis issues parse '- Título — descrição' lines; stance headers parse with emphasis", () => {
    expect(parseSuggestedIssues(SYNTHESIS)).toHaveLength(2);
    expect(parseSuggestedIssues("sem seção")).toEqual([]);
    expect(splitStance("**Stance:** agrees with @Ada\n**Position:** a favor\n\nTexto.")).toEqual({
      body: "Texto.",
      stance: { kind: "agree", handle: "ada" },
      replyTo: null,
      position: "a favor",
    });
    expect(splitStance("Stance: asks people\nQuem tem o funil?").stance).toEqual({ kind: "ask", people: true });
    expect(splitStance("Sem cabeçalho.")).toEqual({
      body: "Sem cabeçalho.",
      stance: null,
      replyTo: null,
      position: null,
    });
  });
});
