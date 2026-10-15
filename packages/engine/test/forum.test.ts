import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  cancelForumTopic,
  concludeForumTopic,
  createAgent,
  createForumIssues,
  createForumTopic,
  createOrganization,
  createRoutine,
  drainOutbox,
  ForbiddenError,
  getForumTopic,
  listChannels,
  listForumTopics,
  NotFoundError,
  parseSuggestedIssues,
  postInForumAsPerson,
  postPersonMessage,
  runRoutineNow,
  setAgentAudience,
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
  "Decisão: seguir com o plano B.",
  "",
  "## Issues sugeridas",
  "- Medir a conversão — antes e depois da mudança",
  "- Atualizar a página de preços — com os novos valores",
].join("\n");

/** Answers by role: a forum turn posts as the agent; the synthesis turn writes the synthesis. */
function forumReply(onTurn?: (handle: string, req: ModelRequest) => void) {
  return (req: ModelRequest) => {
    const handle = /\(@([a-z0-9_-]+)\)/.exec(systemText(req.system ?? ""))?.[1] ?? "?";
    const last = JSON.stringify(req.messages.at(-1)?.content);
    if (last.includes("tool_result")) return { chunks: ["Abri o fórum."] };
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
    if (last.includes("escreva agora a síntese")) return { chunks: [SYNTHESIS] };
    onTurn?.(handle, req);
    return { chunks: [`${handle} acha que sim; @ops, o que você acha?`] };
  };
}

async function twoAgents(reply = forumReply(), budgetNanoUsd?: number) {
  f = await setup({ reply, artifactTools: true, forumTools: true, budgetNanoUsd });
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

describe("rounds", () => {
  test("one run per agent per round, in order, up to the limit; then the synthesis as a Drive document", async () => {
    const { ops } = await twoAgents();
    const topic = await createForumTopic(forum(), { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Plano de preços",
      goal: "Decidir o plano de entrada.",
      agentIds: [f.agent.id, ops.id],
      rounds: 2,
    });
    expect(topic).toMatchObject({ status: "open", rounds: 2, agentIds: [f.agent.id, ops.id], userIds: [f.owner.id] });
    await drainOutbox(f.db, f.handlers);

    const done = await getForumTopic(f.db, f.owner.id, f.org.id, topic.id);
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
    // The synthesis: a document in the Drive, with the suggested issues.
    expect(done.synthesis?.suggestedIssues).toEqual([
      { title: "Medir a conversão", description: "antes e depois da mudança" },
      { title: "Atualizar a página de preços", description: "com os novos valores" },
    ]);
    const [artifact] = await f.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, done.synthesis?.artifactId ?? ""));
    expect(artifact).toMatchObject({ kind: "document", title: "Síntese: Plano de preços" });
    // Issues only when a person approves them.
    const { numbers } = await createForumIssues(
      forum(),
      f.owner.id,
      f.org.id,
      topic.id,
      done.synthesis?.suggestedIssues ?? [],
    );
    expect(numbers).toHaveLength(2);
    // The forum channel is not a chat channel.
    expect((await listChannels(f.db, f.owner.id, f.org.id)).map((c) => c.id)).not.toContain(topic.channelId);
    await expect(
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, topic.channelId, { body: "oi" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("the budget cap stops the discussion and goes to the synthesis", async () => {
    const { ops } = await twoAgents();
    const topic = await createForumTopic(forum(), { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Caro",
      goal: "Gastar pouco.",
      agentIds: [f.agent.id, ops.id],
      rounds: 3,
      budgetUsd: 1e-9,
    });
    await drainOutbox(f.db, f.handlers);
    const done = await getForumTopic(f.db, f.owner.id, f.org.id, topic.id);
    expect(done.status).toBe("done");
    expect(done.posts.filter((p) => !p.meta?.synthesis)).toHaveLength(1);
    expect(await runs()).toHaveLength(2);
  });

  test("a person's post ends the round early and leads the next; Concluir stops after the current turn", async () => {
    let lastPrompt = "";
    const { ops } = await twoAgents(
      forumReply((_handle, req) => {
        lastPrompt = JSON.stringify(req.messages);
      }),
    );
    const topic = await createForumTopic(forum(), { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Onboarding",
      goal: "Achar o que trava.",
      agentIds: [f.agent.id, ops.id],
      rounds: 3,
    });
    await drainOutbox(f.db, f.handlers, { maxBatches: 2 }); // start + dev's round-1 turn
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id]);
    const post = await postInForumAsPerson(forum(), f.owner.id, f.org.id, topic.id, "Lembrem do custo do PC.");
    expect(post.round).toBe(1);
    await drainOutbox(f.db, f.handlers, { maxBatches: 2 });
    // ops' round-1 turn was skipped: the person's post leads round 2, which dev reads.
    expect((await runs()).map((r) => r.agentId)).toEqual([f.agent.id, f.agent.id]);
    expect(lastPrompt).toContain("Lembrem do custo do PC.");
    await concludeForumTopic(forum(), f.owner.id, f.org.id, topic.id);
    await drainOutbox(f.db, f.handlers);
    const done = await getForumTopic(f.db, f.owner.id, f.org.id, topic.id);
    expect(done.status).toBe("done");
    expect((await runs()).length).toBe(3); // dev r1, dev r2, synthesis
  });
});

describe("from the chat and from routines", () => {
  test("@dev leva isso pro fórum: the tool opens it; the synthesis comes back to the thread", async () => {
    f = await setup({ reply: forumReply(), artifactTools: true, forumTools: true });
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev leva isso pro fórum: qual plano de entrada?",
    });
    await drainOutbox(f.db, f.handlers);
    const [topic] = await listForumTopics(f.db, f.owner.id, f.org.id);
    expect(topic).toMatchObject({
      title: "Preços do Q1",
      status: "done",
      originChannelId: f.general.id,
      createdBy: { type: "agent", id: f.agent.id },
    });
    const back = (await f.db.select().from(schema.messages)).find((m) => m.meta.forumTopicId === topic?.id);
    expect(back).toMatchObject({ channelId: f.general.id, threadId: ask.id, authorAgentId: f.agent.id });
    expect(back?.meta.artifacts).toEqual([{ id: topic?.synthesis?.artifactId, version: 1 }]);
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
    expect(topic?.title.startsWith("Retrospectiva — ")).toBe(true);
    expect(topic?.goal).toBe("O que deu certo e o que não deu nesta semana?");
    expect(topic?.agentIds.sort()).toEqual([f.agent.id, ops.id].sort());
    expect(topic?.status).toBe("done");
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
    const topic = await createForumTopic(forum(), { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Só nosso",
      goal: "Algo.",
      agentIds: [f.agent.id],
      rounds: 1,
    });
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

  test("synthesis issues parse '- Título — descrição' lines", () => {
    expect(parseSuggestedIssues(SYNTHESIS)).toHaveLength(2);
    expect(parseSuggestedIssues("sem seção")).toEqual([]);
  });
});
