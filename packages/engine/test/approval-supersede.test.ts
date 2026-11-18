import { afterEach, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { approvalTarget, decideApproval, drainOutbox, postPersonMessage, type ToolSource } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "A pessoa pediu para responder o e-mail de feedback.";
const EMAIL = "3f2a9c1e-5b7d-4e8f-a1c2-d3e4f5a6b7c8";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

const sent: string[] = [];
const mail: ToolSource = {
  name: "mail",
  tools: async () => [
    {
      name: "reply_to_received_email",
      description: "Reply to a received email",
      scope: "",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: { email_id: { type: "string" }, subject: { type: "string" }, text: { type: "string" } },
      },
      execute: async (input) => {
        sent.push((input as { text: string }).text);
        return { content: "sent" };
      },
    },
  ],
};

const reply = (emailId: string, text: string) => ({
  name: "reply_to_received_email",
  input: { email_id: emailId, subject: "Re: Feedback", text, why: WHY },
});

/** What each model call got, in order: the old run's resume reads its replaced request there. */
const prompts: string[] = [];

async function twoAsks(second: string) {
  sent.length = 0;
  prompts.length = 0;
  f = await setup({
    toolSources: [mail],
    reply: (req, call) => {
      prompts.push(JSON.stringify(req));
      if (call === 1) return { chunks: ["Rascunho pronto."], toolUses: [reply(EMAIL, "Oi, Rita. Obrigado.")] };
      if (call === 2) return { chunks: ["Ajustei."], toolUses: [reply(second, "Oi, Rita. Obrigado pelo beta.")] };
      // The replaced run, resumed: nothing left to say.
      return { chunks: [] };
    },
  });
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  const ask = await post("@dev responde o feedback que chegou");
  await drainOutbox(f.db, f.handlers);
  const events = f.listen(f.general.id);
  await post("@dev ajusta: agradece pelo beta", ask.id);
  await drainOutbox(f.db, f.handlers);
  const rows = await f.db.select().from(schema.approvals).orderBy(asc(schema.approvals.createdAt));
  const runs = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
  return { rows, runs, events };
}

test("asked again in a later turn for the same email: the older request is replaced on the same card and its run ends quietly", async () => {
  const { rows, runs, events } = await twoAsks(EMAIL);
  const [old, fresh] = rows;
  if (!old || !fresh) throw new Error("two requests expected");
  expect(old.status).toBe("canceled");
  expect(old.supersededById).toBe(fresh.id);
  expect(fresh.status).toBe("pending");
  // One card: the new request joined the old one's before replacing it.
  expect(fresh.messageId).toBe(old.messageId);
  // The card heard the old one end, said as replaced.
  const decided = events.find((e) => e.type === "approval.decided") as
    | { approval?: { id: string; supersededById: string | null } }
    | undefined;
  expect(decided?.approval).toMatchObject({ id: old.id, supersededById: fresh.id });
  // The old run read it was replaced, not refused, and said nothing.
  const [first] = runs;
  expect(first?.status).toBe("done");
  expect(prompts[2]).toContain("Replaced by your newer request");
  expect(prompts[2]).not.toContain("refused this action");
  const said = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.agentRunId, first?.id ?? ""));
  expect(said.filter((m) => typeof m.meta.approvalId !== "string").map((m) => m.body)).toEqual([]);
  // Approving the new one sends it once, the old text never.
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, fresh.id, { decision: "approve" });
  await drainOutbox(f.db, f.handlers);
  expect(sent).toEqual(["Oi, Rita. Obrigado pelo beta."]);
});

test("another email is another action: both requests keep waiting", async () => {
  const { rows } = await twoAsks(OTHER);
  expect(rows.map((r) => [r.status, r.supersededById])).toEqual([
    ["pending", null],
    ["pending", null],
  ]);
});

test("an action's target: its ids and names, one level into a wrapped call; none, and nothing is ever replaced", () => {
  expect(approvalTarget({ email_id: EMAIL, text: "a" })).toBe(approvalTarget({ text: "b", email_id: EMAIL }));
  expect(approvalTarget({ email_id: EMAIL })).not.toBe(approvalTarget({ email_id: OTHER }));
  expect(approvalTarget({ name: "SEND", arguments: { to: "a@example.com", body: "x" } })).toBe(
    approvalTarget({ name: "SEND", arguments: { to: "a@example.com", body: "y" } }),
  );
  expect(approvalTarget({ month: "2026-11", revenue: 1 })).toBeNull();
});
