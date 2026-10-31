import { afterEach, describe, expect, test } from "bun:test";
import { sealSecret, secretAad } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  answerQuestion,
  CONSULTATION_TTL_MS,
  cancelRun,
  consultationConversation,
  consultationsIn,
  createAgent,
  decideApproval,
  deliverSecret,
  drainOutbox,
  expireConsultations,
  grantScopes,
  insertMessage,
  type JobHandlers,
  listDms,
  listMessages,
  type MachineHub,
  postPersonMessage,
  recoverStaleRuns,
  setAgentComputerTarget,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
/** The consulted agent's run: its prompt says it is in a conversation between agents. */
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

const consultations = () => f.db.select().from(schema.agentConsultations);
const runs = () => f.db.select().from(schema.agentRuns);

async function addInfra() {
  return createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Infra",
      handle: "infra",
      role: "Infrastructure",
      instructions: "You run the servers.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
}

/**
 * @dev asks @infra on "deploy" and carries on (it never waits); @infra answers from its DM; the
 * answer comes back as a notice and @dev relays what it heard.
 */
const consultReply = (infraSays: (req: ModelRequest) => ReturnType<typeof answer>) => (req: ModelRequest) => {
  if (inAgentDm(req)) return infraSays(req);
  const last = lastText(req);
  const heard = /your question to @infra\]: ([^"\\]+)/.exec(last);
  if (heard) return { chunks: [`Relaying: ${heard[1]}`] };
  if (last.includes("tool_result"))
    return { chunks: ["Asked @infra how staging is deployed; I'll tell you when it answers."] };
  if (last.includes("deploy"))
    return {
      chunks: [],
      toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?" } }],
    };
  return { chunks: ["ok"] };
};
const answer = (text: string) => ({ chunks: [text] });

describe("ask_agent", () => {
  test("an agent asks another in their private DM, carries on, and relays the answer when it comes", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("Staging deploys with deploy.sh")) });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    const [c] = await consultations();
    expect(c).toMatchObject({
      askerAgentId: f.agent.id,
      targetAgentId: infra.id,
      question: "How is staging deployed?",
      status: "answered",
      answer: "Staging deploys with deploy.sh",
      chain: [f.agent.id],
    });
    // The DM has the two agents only: no person reads it, nor sees it in their DMs.
    const [dm] = await f.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, c?.channelId ?? ""));
    expect(dm?.kind).toBe("dm");
    expect(dm?.dmKey).not.toContain("u:");
    const members = await f.db
      .select({ agentId: schema.channelMembers.agentId, userId: schema.channelMembers.userId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, c?.channelId ?? ""));
    expect(members.map((m) => m.agentId).sort()).toEqual([f.agent.id, infra.id].sort());
    expect(members.every((m) => m.userId === null)).toBe(true);
    expect((await listDms(f.db, f.owner.id, f.org.id)).map((d) => d.channelId)).not.toContain(c?.channelId);

    // The asking run never paused: it told the person and ended. The answer came as a notice where it
    // was asked, and a run of the asker relayed it there.
    const all = await runs();
    expect(all.every((r) => r.status === "done")).toBe(true);
    expect(all.some((r) => r.status === "waiting_input")).toBe(false);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const told = timeline.findIndex((m) => m.body.startsWith("Asked @infra"));
    const notice = timeline.findIndex(
      (m) => (m.meta as { notice?: { kind?: string } }).notice?.kind === "consult_reply",
    );
    expect(told).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(told);
    // The people see it as the consultation it was: who asked whom, the question and the answer apart.
    const meta = timeline[notice]?.meta as { notice?: { refs?: Record<string, string> } } | undefined;
    const refs = meta?.notice?.refs;
    expect(refs).toMatchObject({ askerAgentId: f.agent.id, agentId: infra.id, status: "answered" });
    expect(refs?.question).toBeTruthy();
    expect(refs?.answer).toBeTruthy();
    const reply = timeline.at(-1);
    expect(reply?.body).toBe("Relaying: Staging deploys with deploy.sh");
    await Bun.sleep(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consulting", agentId: f.agent.id, consultedAgentId: infra.id }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consulted", agentId: f.agent.id, consultedAgentId: infra.id }),
    );
  });

  test("a consulted agent's approval shows where the person asked, not in the agents' DM", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const ask = await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);

    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({
      agentId: infra.id,
      channelId: f.general.id,
      threadRootId: ask.id,
      status: "pending",
    });
    // The card is in the channel's timeline, where the person asked; the approval keeps the conversation.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.approvalId === approval?.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    expect(github.executed).toHaveLength(0);
    expect((await consultations())[0]?.status).toBe("open");
  });

  test("approved where the person asked: the consulted agent goes on, and that conversation hears so", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);
    const [approval] = await f.db.select().from(schema.approvals);
    const [row] = await consultations();
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]?.waiting).toBe("approval");
    await Bun.sleep(5);
    const mark = events.length;

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect(github.executed).toHaveLength(1);
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Merged." });
    await Bun.sleep(5);
    // Back at work, the question shows as no longer held (`agent.consultation`), before its answer closes it.
    const later = events.slice(mark);
    const resumed = later.findIndex((e) => e.type === "agent.consultation" && e.consultationId === row?.id);
    expect(resumed).toBeGreaterThanOrEqual(0);
    expect(later[resumed]).toMatchObject({ channelId: f.general.id, runId: row?.askerRunId });
    expect(resumed).toBeLessThan(later.findIndex((e) => e.type === "agent.consulted"));
  });

  test("a consulted agent's question shows where the person asked; answering it there resumes it", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      reply: consultReply((req) => {
        const picked = /The person answered: (\w+)/.exec(lastText(req));
        if (picked) return answer(`Staging deploys from ${picked[1]}.`);
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: {
                why: "Staging can deploy from two branches, and which one changes the steps I give back.",
                question: "Which branch goes to staging?",
                choices: ["main", "release"],
              },
            },
          ],
        };
      }),
    });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    // The question waits where the person asked (the asker replied in the main timeline), not in the agents' DM.
    const [q] = await f.db.select().from(schema.agentQuestions);
    expect(q).toMatchObject({ agentId: infra.id, channelId: f.general.id, threadId: null, status: "open" });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.questionId === q?.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    const target = (await runs()).find((r) => r.agentId === infra.id);
    expect(target?.status).toBe("waiting_input");
    const [held] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(held).toMatchObject({ status: "open", waiting: "input" });
    await Bun.sleep(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "question.asked", question: expect.objectContaining({ id: q?.id }) }),
    );
    const mark = events.length;

    // Anyone who reads that conversation answers it there; the consulted run picks it up in its DM.
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", { choice: "release" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).find((r) => r.id === target?.id)?.status).toBe("done");
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Staging deploys from release." });
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.at(-1)?.body).toBe("Relaying: Staging deploys from release.");
    await Bun.sleep(5);
    const later = events.slice(mark);
    const resumed = later.findIndex((e) => e.type === "agent.consultation");
    expect(resumed).toBeGreaterThanOrEqual(0);
    expect(resumed).toBeLessThan(later.findIndex((e) => e.type === "agent.consulted"));
  });

  test("a note's run asks no person: it answers no consultation", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      reply: (req) => {
        const last = lastText(req);
        if (inAgentDm(req)) {
          if (last.includes("tool_result")) return answer("Noted.");
          return {
            chunks: [],
            toolUses: [
              {
                name: "ask_user",
                input: {
                  why: "The note doesn't say which deploy finished, and the metrics to watch depend on it.",
                  question: "Which deploy?",
                },
              },
            ],
          };
        }
        if (last.includes("tool_result")) return answer("Told Infra.");
        return {
          chunks: [],
          toolUses: [{ name: "tell_agent", input: { agent: "@infra", message: "The deploy to staging finished." } }],
        };
      },
    });
    await addInfra();
    await post("@dev tell infra the deploy finished");
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentQuestions)).toHaveLength(0);
    const refused = f.provider.calls
      .map((c) => c.request)
      .find((r) => inAgentDm(r) && lastText(r).includes("tool_result"));
    expect(lastText(refused as ModelRequest)).toContain("No person reads this conversation");
  });

  test("a consulted agent's secret request goes to the person behind it, where they asked", async () => {
    const VALUE = "npm_s3cr3t_value_0123456789";
    f = await setup({
      askAgent: true,
      machines: true,
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Signed in to the registry.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "request_secret",
                  input: { name: "NPM_TOKEN", purpose: "sign in to the package registry", target: "env" },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    // @infra's own computer, its runner online (the key is made there and the value goes there).
    const deps = { db: f.db, pubsub: f.pubsub };
    const paired = await pairMachine(deps, f.owner.id, f.org.id, { name: "Build box", ...RUNNER, exec: true });
    await grantScopes(f.db, f.org.id, infra.id, [{ connectionId: null, scope: "sandbox:run" }]);
    await setAgentComputerTarget(deps, f.owner.id, f.org.id, infra.id, paired.machineId);
    const runner = fakeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const events = f.listen(f.general.id);
    await post("@dev deploy staging");
    await drainOutbox(f.db, f.handlers);

    const [request] = await f.db.select().from(schema.secretRequests);
    if (!request) throw new Error("no secret request");
    expect(request).toMatchObject({
      agentId: infra.id,
      channelId: f.general.id,
      threadId: null,
      requestedForUserId: f.owner.id,
      status: "pending",
    });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.secretRequestId === request.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]?.waiting).toBe("input");
    await Bun.sleep(5);
    const mark = events.length;

    const box = await sealSecret(
      request.publicKey,
      VALUE,
      secretAad({ requestId: request.id, orgId: f.org.id, name: request.name, target: { kind: "env" } }),
    );
    const sandbox = { ...(f.sandboxDeps as NonNullable<typeof f.sandboxDeps>), pubsub: f.pubsub };
    await deliverSecret(sandbox, f.owner.id, f.org.id, request.id, box);
    expect(runner.secrets.get("NPM_TOKEN")).toBe(VALUE);
    await drainOutbox(f.db, f.handlers);
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Signed in to the registry." });
    await Bun.sleep(5);
    expect(events.slice(mark)).toContainEqual(expect.objectContaining({ type: "agent.consultation" }));
  });

  test("the conversation's list: each question by the run that asked, waiting on a person while held", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);

    const [row] = await consultations();
    const list = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: row?.id,
      runId: row?.askerRunId,
      agentId: f.agent.id,
      consultedAgentId: infra.id,
      status: "open",
      waiting: "approval",
      question: "How is staging deployed?",
      answer: null,
    });
    // The asking reply carries the run the list is grouped by.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.some((m) => m.agentRunId === row?.askerRunId)).toBe(true);
    await Bun.sleep(5);
    // The conversation that asked hears the question is held on a person.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consultation", runId: row?.askerRunId, consultationId: row?.id }),
    );
    // Another conversation's list doesn't have it.
    const other = await f.db.select().from(schema.channels).where(eq(schema.channels.id, row?.channelId ?? ""));
    expect(await consultationsIn(f.db, f.org.id, other[0]?.id ?? "")).toEqual([]);
  });

  test("answered and expired questions in the list: the answer once answered, none once expired", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("Staging deploys with deploy.sh")) });
    await addInfra();
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);
    const [answered] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(answered).toMatchObject({
      status: "answered",
      waiting: null,
      answer: "Staging deploys with deploy.sh",
    });
    expect(answered?.answeredAt).toBeInstanceOf(Date);

    await f.db
      .update(schema.agentConsultations)
      .set({ status: "expired", answer: "leftover" })
      .where(eq(schema.agentConsultations.id, answered?.id ?? ""));
    const [expired] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(expired).toMatchObject({ status: "expired", answer: null });
  });

  test("an opened question: the question in the DM, then the consulted run's messages and its card here", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);
    const [row] = await consultations();
    if (!row?.targetRunId) throw new Error("the consulted run didn't start");
    const dm = row.channelId;
    const opened = () => consultationConversation(f.db, f.org.id, f.general.id, row.id);
    // The same DM also holds what the two say for other people: never part of this question.
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0 },
      body: "Another question, for someone else",
    });
    // The consulted run's own words in the DM are.
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: infra.id, runId: row.targetRunId, hop: 1 },
      body: "Checking the deploy logs first.",
    });

    const first = await opened();
    expect(first?.consultation).toMatchObject({
      id: row.id,
      status: "open",
      waiting: "approval",
      consultedRunId: row.targetRunId,
    });
    const list = first?.messages ?? [];
    // First the question, as it went into the agents' DM.
    expect(list[0]).toMatchObject({ channelId: dm, body: "How is staging deployed?" });
    // What the consulted run wrote there, and the approval it asked for, on its card where the person asked.
    expect(list.some((m) => m.channelId === dm && m.body === "Checking the deploy logs first.")).toBe(true);
    expect(list.some((m) => m.channelId === f.general.id && typeof m.meta.approvalId === "string")).toBe(true);
    // Nothing else: every other message is the consulted run's.
    expect(list.slice(1).every((m) => m.agentRunId === row.targetRunId)).toBe(true);
    expect(list.some((m) => m.body.startsWith("Another question"))).toBe(false);
    // Opened only from the conversation that asked it.
    expect(await consultationConversation(f.db, f.org.id, dm, row.id)).toBeNull();

    // The run, still at work, takes a question the same person asked from another conversation: its words in the
    // DM may be about that one, so they leave this panel; the question and its card here stay.
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0 },
      body: "Started elsewhere",
    });
    const asker = (await runs()).find((r) => r.id === row.askerRunId);
    if (!asker) throw new Error("no asking run");
    const [elsewhere] = await f.db
      .insert(schema.agentRuns)
      .values({
        ...asker,
        id: Bun.randomUUIDv7(),
        channelId: dm,
        triggerMessageId: trigger.id,
        threadRootId: trigger.id,
      })
      .returning();
    const otherId = Bun.randomUUIDv7();
    const other = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: f.agent.id, runId: elsewhere?.id ?? null, hop: 0 },
      body: "Is production up?",
      meta: { consultation: { id: otherId } },
    });
    await f.db.insert(schema.agentConsultations).values({
      ...row,
      id: otherId,
      askerRunId: elsewhere?.id ?? "",
      messageId: other.id,
      waitId: `${row.waitId}-elsewhere`,
      question: "Is production up?",
    });
    const shared = (await opened())?.messages ?? [];
    expect(shared[0]?.body).toBe("How is staging deployed?");
    expect(shared.some((m) => m.body === "Checking the deploy logs first.")).toBe(false);
    expect(shared.some((m) => m.channelId === f.general.id && typeof m.meta.approvalId === "string")).toBe(true);
  });

  test("no cycles: the consulted agent can't ask back the one asking it", async () => {
    let infraCalls = 0;
    f = await setup({
      askAgent: true,
      reply: consultReply((req) => {
        infraCalls++;
        if (lastText(req).includes("tool_result")) return answer("I don't know more than that.");
        return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "dev", question: "Which app?" } }] };
      }),
    });
    await addInfra();
    await post("@dev deploy staging");
    await drainOutbox(f.db, f.handlers);

    expect(await consultations()).toHaveLength(1);
    expect(infraCalls).toBe(2);
    const infraRetry = f.provider.calls
      .map((c) => c.request)
      .find((r) => inAgentDm(r) && lastText(r).includes("tool_result"));
    expect(lastText(infraRetry as ModelRequest)).toContain("already part of this consultation");
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "I don't know more than that." });
  });

  test("unknown agents and asking yourself are refused", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["fine"] };
        // The second run also reads the first message (replies go to threads): newest request first.
        if (last.includes("self"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@dev", question: "hi?" } }] };
        if (last.includes("ghost"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@ghost", question: "hi?" } }] };
        return { chunks: ["ok"] };
      },
    });
    await post("@dev ask ghost");
    await drainOutbox(f.db, f.handlers);
    await post("@dev ask self");
    await drainOutbox(f.db, f.handlers);
    expect(await consultations()).toHaveLength(0);
    const results = f.provider.calls.map((c) => lastText(c.request)).filter((t) => t.includes("tool_result"));
    expect(results.some((t) => t.includes("There is no agent @ghost"))).toBe(true);
    expect(results.some((t) => t.includes("That is you"))).toBe(true);
  });

  test("no answer in time: the asker hears it, as a notice", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const infra = await addInfra();
    // @infra never runs: its execute jobs are dropped.
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    // It never waits: the asking run ended after telling the person.
    const asker = (await runs()).find((r) => r.agentId === f.agent.id);
    expect(asker?.status).toBe("done");

    expect(await expireConsultations({ db: f.db }, new Date(Date.now() + CONSULTATION_TTL_MS + 1000))).toBe(1);
    await drainOutbox(f.db, handlers);
    expect((await consultations())[0]?.status).toBe("expired");
    // Nobody waits for @infra anymore: its run stops instead of holding the DM.
    expect((await runs()).find((r) => r.agentId === infra.id)).toMatchObject({
      status: "canceled",
      error: "consultation_expired",
    });
    expect((await runs()).filter((r) => r.agentId === f.agent.id).every((r) => r.status === "done")).toBe(true);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("didn't answer within 15 minutes");
  });

  test("the consulted run dies with its worker: the asker hears it at once, not after 15 minutes", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const infra = await addInfra();
    // @infra's job is lost with its worker (a deploy mid-tool): the run stays "running" with no heartbeat.
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    const target = (await runs()).find((r) => r.agentId === infra.id);
    if (!target) throw new Error("no consulted run");
    const long = new Date(Date.now() - 10 * 60_000);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: long, heartbeatAt: long })
      .where(eq(schema.agentRuns.id, target.id));

    expect((await recoverStaleRuns({ db: f.db })).failed).toEqual([target.id]);
    await drainOutbox(f.db, handlers);
    expect((await consultations())[0]?.status).toBe("failed");
    expect((await runs()).filter((r) => r.agentId === f.agent.id).every((r) => r.status === "done")).toBe(true);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("No answer: it couldn't");
  });

  test("a consulted run waiting for its computer waits on no person; stopped there, it closes at once", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const infra = await addInfra();
    // @infra's job never runs here: its run is then parked the way a run whose computer is offline is.
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    const target = (await runs()).find((r) => r.agentId === infra.id);
    if (!target) throw new Error("no consulted run");
    const machineId = Bun.randomUUIDv7();
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        waitingMachineId: machineId,
        transcript: {
          messages: [],
          postedUpTo: 0,
          postedCount: 0,
          deltaSeq: 0,
          waitingForBrain: { kind: "claude_code", machineId, code: "machine_offline", waitId: Bun.randomUUIDv7() },
        },
      })
      .where(eq(schema.agentRuns.id, target.id));
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]).toMatchObject({
      status: "open",
      waiting: "computer",
    });

    // Stopped while parked (nobody executes it): the question closes now, not after 15 minutes.
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, target.id);
    expect((await consultations())[0]).toMatchObject({ status: "failed", answer: "stopped by a person" });
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]).toMatchObject({
      status: "failed",
      waiting: null,
    });
  });

  test("a consulted run stopped while held on an approval: the asker hears it at once, and once", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);
    const target = (await runs()).find((r) => r.agentId === infra.id);
    if (!target) throw new Error("no consulted run");
    expect(target.status).toBe("waiting_approval");
    expect((await consultations())[0]?.status).toBe("open");
    await Bun.sleep(5);
    const mark = events.length;

    // Stopped from the app while held: no worker executes it, so no run end closes the question.
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, target.id);
    expect((await consultations())[0]).toMatchObject({ status: "failed", answer: "stopped by a person" });
    expect((await f.db.select().from(schema.approvals))[0]?.status).toBe("canceled");
    expect(github.executed).toHaveLength(0);
    // Where the person asked: the usual answer notice, and the "asking…" line ends.
    const isReply = (m: { meta: unknown }) =>
      (m.meta as { notice?: { kind?: string } }).notice?.kind === "consult_reply";
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const meta = timeline.find(isReply)?.meta as { notice?: { refs?: Record<string, string> } } | undefined;
    expect(meta?.notice?.refs).toMatchObject({
      askerAgentId: f.agent.id,
      agentId: infra.id,
      status: "failed",
    });
    await Bun.sleep(5);
    expect(events.slice(mark)).toContainEqual(
      expect.objectContaining({
        type: "agent.consulted",
        agentId: f.agent.id,
        consultedAgentId: infra.id,
        status: "failed",
      }),
    );

    // The asker relays it once; the 15-minute sweep finds nothing left to close.
    await drainOutbox(f.db, f.handlers);
    expect(await expireConsultations({ db: f.db }, new Date(Date.now() + CONSULTATION_TTL_MS + 1000))).toBe(0);
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.filter(isReply)).toHaveLength(1);
    expect(after.at(-1)?.body).toContain("stopped by a person");
    expect(github.executed).toHaveLength(0);
  });
});
