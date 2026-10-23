import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  CONSULTATION_TTL_MS,
  createAgent,
  drainOutbox,
  expireConsultations,
  grantScopes,
  type JobHandlers,
  listDms,
  listMessages,
  postPersonMessage,
  recoverStaleRuns,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(() => f?.close());

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

/** @dev asks @infra on "deploy" and waits; @infra answers from its DM; @dev relays what it heard. */
const consultReply = (infraSays: (req: ModelRequest) => ReturnType<typeof answer>) => (req: ModelRequest) => {
  if (inAgentDm(req)) return infraSays(req);
  const last = lastText(req);
  if (last.includes("tool_result"))
    return { chunks: [`Relaying: ${/instructions\):\\n\\n([^"]+)/.exec(last)?.[1] ?? last}`] };
  if (last.includes("deploy"))
    return {
      chunks: [],
      toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?", wait: true } }],
    };
  return { chunks: ["ok"] };
};
const answer = (text: string) => ({ chunks: [text] });

describe("ask_agent", () => {
  test("an agent asks another in their private DM, waits, and goes on with the answer", async () => {
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

    // The asking run heard the answer and replied where it was asked (D67), with the "message from @infra" card.
    const all = await runs();
    expect(all.every((r) => r.status === "done")).toBe(true);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const reply = timeline.at(-1);
    expect(reply?.body).toContain("deploy.sh");
    expect(reply?.meta.consulted).toEqual([
      {
        agentId: infra.id,
        consultationId: c?.id,
        status: "answered",
        question: "How is staging deployed?",
        answer: "Staging deploys with deploy.sh",
      },
    ]);
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
          : { chunks: [], toolUses: [{ name: "github_merge_pr", input: { repo: "acme/app", pr: 7 } }] },
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
    // The card is in the channel's timeline, where the person asked (D67); the approval keeps the conversation.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.approvalId === approval?.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    expect(github.executed).toHaveLength(0);
    expect((await consultations())[0]?.status).toBe("open");
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

  test("no answer in time: the asking run goes on without it", async () => {
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
    const asker = (await runs()).find((r) => r.agentId === f.agent.id);
    expect(asker?.status).toBe("waiting_input");

    expect(await expireConsultations({ db: f.db }, new Date(Date.now() + CONSULTATION_TTL_MS + 1000))).toBe(1);
    await drainOutbox(f.db, handlers);
    expect((await consultations())[0]?.status).toBe("expired");
    // Nobody waits for @infra anymore: its run stops instead of holding the DM.
    expect((await runs()).find((r) => r.agentId === infra.id)).toMatchObject({
      status: "canceled",
      error: "consultation_expired",
    });
    expect((await runs()).find((r) => r.id === asker?.id)?.status).toBe("done");
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
    expect((await runs()).find((r) => r.agentId === f.agent.id)?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("couldn't answer");
  });
});
