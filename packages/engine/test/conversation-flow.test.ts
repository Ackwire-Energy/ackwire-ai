import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import { decideApproval, drainOutbox, postPersonMessage, type ToolSource } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "A pessoa pediu para gravar as metas do mês no painel.";

const goals: ToolSource = {
  name: "goals",
  tools: async () => [
    {
      name: "goal_upsert",
      description: "Record a monthly goal",
      scope: "",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: { role: { type: "string" }, month: { type: "string" }, revenue: { type: "number" } },
      },
      describe: () => ({ title: "Painel: goal upsert" }),
      execute: async (input) => ({ content: `recorded ${(input as { month: string }).month}` }),
    },
  ],
};

const userText = (call: number) =>
  (f.provider.calls[call - 1]?.request.messages ?? [])
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.flatMap((b) =>
            b.type === "text" ? [b.text] : b.type === "tool_result" ? [String(b.content)] : [],
          ),
    )
    .join("\n");

test("a message sent while the agent's run waits on an approval: the new run knows what waits, the resumed one what was said meanwhile", async () => {
  f = await setup({
    toolSources: [goals],
    reply: (_req, call) =>
      call === 1
        ? {
            chunks: ["Gravando outubro."],
            toolUses: [{ name: "goal_upsert", input: { role: "seller", month: "2026-10", revenue: 97000, why: WHY } }],
          }
        : call === 2
          ? { chunks: ["A de influencer fica para depois do painel."] }
          : { chunks: ["Outubro gravado."] },
  });
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  const ask = await post("@dev grava as metas de outubro");
  await drainOutbox(f.db, f.handlers);
  const [held] = await f.db.select().from(schema.agentRuns);
  expect(held?.status).toBe("waiting_approval");

  // The held run takes nothing new (the decision may take hours): a run of its own answers now…
  await post("@dev grava a de influencer também", ask.id);
  await drainOutbox(f.db, f.handlers);
  const runs = await f.db.select().from(schema.agentRuns);
  expect(runs).toHaveLength(2);
  // …knowing what its other run already asked, so it neither asks again nor restates it.
  const second = systemText(f.provider.calls[1]?.request.system ?? []);
  expect(second).toContain("# Already waiting for approval here");
  expect(second).toContain("Painel: goal upsert (role=seller, month=2026-10, revenue=97000");

  const [approval] = await f.db.select().from(schema.approvals);
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, f.handlers);
  expect(
    (
      await f.db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, held?.id ?? ""))
    )[0]?.status,
  ).toBe("done");
  // The resumed run reads what was said while it waited, after its call's result.
  const resumed = userText(3);
  expect(resumed).toContain("recorded 2026-10");
  expect(resumed).toContain("While you waited, the conversation went on");
  expect(resumed).toContain("@dev grava a de influencer também");
  expect(resumed).toContain("[You, in another run]: A de influencer fica para depois do painel.");
  expect(f.provider.calls).toHaveLength(3);
});
