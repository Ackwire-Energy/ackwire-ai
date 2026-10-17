import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  CONSULTATION_TTL_MS,
  createAgent,
  drainOutbox,
  expireConsultations,
  type JobHandlers,
  listDms,
  listMessages,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";

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

/** @dev asks @infra on "deploy"; @infra answers from its DM; @dev relays what it heard. */
const consultReply = (infraSays: (req: ModelRequest) => ReturnType<typeof answer>) => (req: ModelRequest) => {
  if (inAgentDm(req)) return infraSays(req);
  const last = lastText(req);
  if (last.includes("tool_result"))
    return { chunks: [`Relaying: ${/answered:\\n\\n([^"]+)/.exec(last)?.[1] ?? last}`] };
  if (last.includes("deploy"))
    return {
      chunks: [],
      toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?" } }],
    };
  return { chunks: ["ok"] };
};
const answer = (text: string) => ({ chunks: [text] });

describe("ask_agent", () => {
  test("an agent asks another in their private DM, waits, and goes on with the answer", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("Staging deploys with deploy.sh")) });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    const ask = await post("@dev how do we deploy to staging?");
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

    // The asking run heard the answer and replied in the thread, with the "message from @infra" card.
    const all = await runs();
    expect(all.every((r) => r.status === "done")).toBe(true);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    const reply = thread.at(-1);
    expect(reply?.body).toContain("deploy.sh");
    expect(reply?.meta.consulted).toEqual([{ agentId: infra.id, consultationId: c?.id, status: "answered" }]);
    await Bun.sleep(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consulted", agentId: f.agent.id, consultedAgentId: infra.id }),
    );
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
        if (last.includes("ghost"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@ghost", question: "hi?" } }] };
        if (last.includes("self"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@dev", question: "hi?" } }] };
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
    expect((await runs()).find((r) => r.id === asker?.id)?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("didn't answer within 15 minutes");
  });
});
