import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, listMessages, postPersonMessage, type ToolSource } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
const runs = async () =>
  (await f.db.select().from(schema.agentRuns)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

/** A tool that, while it runs, lets the test do something (a person writes in the thread). */
function slowTool(during: () => Promise<unknown>): ToolSource {
  return {
    name: "slow",
    tools: async () => [
      {
        name: "build",
        description: "Build the project",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          await during();
          return { content: "build ok" };
        },
      },
    ],
  };
}

describe("mid-round queueing (ADR 0029 section 1)", () => {
  test("a reply in the thread while the agent works there joins that run: no mention, no second run", async () => {
    let threadId = "";
    const requests: string[] = [];
    f = await setup({
      toolSources: [slowTool(() => post("also bump the version", threadId))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Built, version bumped."] };
      },
    });
    const ask = await post("@dev build the project");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(2);
    expect(requests[1]).toContain("New message from ana, while you were working");
    expect(requests[1]).toContain("also bump the version");
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId });
    expect(thread.at(-1)?.body).toBe("Built, version bumped.");
  });

  test("a new message in the channel calling the agent while it works there joins that run: one agent, not two", async () => {
    const requests: string[] = [];
    f = await setup({
      // While the first answer runs, someone else calls the same agent with a new message in the channel.
      toolSources: [slowTool(() => post("@dev and fix the login too"))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Built, and the login is fixed."] };
      },
    });
    await post("@dev build the project");
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("and fix the login too");
  });

  test("a new message in the channel doesn't join a run working in a thread's panel", async () => {
    let threadId = "";
    f = await setup({
      toolSources: [slowTool(() => post("@dev something else"))],
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Done."] },
    });
    const ask = await post("@dev build the project");
    threadId = ask.id;
    // The thread was opened with "Responder": its run answers in the panel, not in the channel.
    await f.db.insert(schema.threads).values({
      orgId: f.org.id,
      channelId: f.general.id,
      rootMessageId: threadId,
      openedByReplyAt: new Date(),
    });
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(2);
  });

  test("after the run ended, a new message to the agent starts a run as usual", async () => {
    f = await setup({ reply: (_req, call) => ({ chunks: [call === 1 ? "First." : "Second."] }) });
    const ask = await post("@dev first thing");
    await drainOutbox(f.db, f.handlers);
    await post("@dev one more thing", ask.id);
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["done", "done"]);
    expect(all[1]?.threadRootId).toBe(ask.id);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    expect(thread.map((m) => m.body)).toEqual(["@dev first thing", "First.", "@dev one more thing", "Second."]);
  });

  test("a message queued into a run that then fails is not lost: it gets a run of its own", async () => {
    let threadId = "";
    let followUp = "";
    f = await setup({
      reply: (_req: ModelRequest, call: number) => {
        if (call === 1) {
          // Written while the model answers; the answer then fails (a refusal).
          const posting = post("are you there?", threadId).then((m) => {
            followUp = m.id;
          });
          return { chunks: ["Hmm"], hold: posting, stopReason: "refusal" as const };
        }
        return { chunks: ["Yes, here."] };
      },
    });
    const ask = await post("@dev do the risky thing");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["failed", "done"]);
    expect(all[0]?.error).toBe("model_refused");
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(followUp);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId });
    expect(thread.at(-1)?.body).toBe("Yes, here.");
  });
});
