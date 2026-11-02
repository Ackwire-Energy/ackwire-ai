import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { addChannelMember, consolidateItem, listOrgMemoryRows, listProposals } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const answers = (f: Fixture, mode: "owner" | "everyone") =>
  f.db.update(schema.agents).set({ audienceMode: mode }).where(eq(schema.agents.id, f.agent.id));

test("an agent's memory and proposed instructions only for who sees how it works; the workspace's context only for admins", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await answers(f, "owner");
  const lesson = await consolidateItem(f.db, {
    orgId: f.org.id,
    kind: "lesson",
    scopeType: "agent",
    agentId: f.agent.id,
    channelIds: [],
    content: "Ping QA before merging.",
    evidence: [{ type: "human", ref: "x", at: "" }],
    confidence: 0.9,
  });
  const proposal = (base: { target: "agent_instructions" | "org_context"; agentId: string | null }) => ({
    ...base,
    orgId: f.org.id,
    baseHash: "x",
    proposedText: "Answer briefly.",
    diff: "+ Answer briefly.",
    rationale: "Seen 2×.",
    itemIds: [],
  });
  const [forAgent] = await f.db
    .insert(schema.contextProposals)
    .values(proposal({ target: "agent_instructions", agentId: f.agent.id }))
    .returning();
  const [forOrg] = await f.db
    .insert(schema.contextProposals)
    .values(proposal({ target: "org_context", agentId: null }))
    .returning();

  expect((await listOrgMemoryRows(f.db, bia.id, f.org.id)).items).toEqual([]);
  expect(await listProposals(f.db, bia.id, f.org.id)).toEqual([]);
  // Admins see all of it.
  expect((await listOrgMemoryRows(f.db, f.owner.id, f.org.id)).items.map((i) => i.id)).toEqual([lesson.item.id]);
  expect((await listProposals(f.db, f.owner.id, f.org.id)).map((p) => p.id).sort()).toEqual(
    [forAgent?.id ?? "", forOrg?.id ?? ""].sort(),
  );

  // Once it answers her: its memory and proposals, never the workspace's context.
  await answers(f, "everyone");
  expect((await listOrgMemoryRows(f.db, bia.id, f.org.id)).items.map((i) => i.id)).toEqual([lesson.item.id]);
  expect((await listProposals(f.db, bia.id, f.org.id)).map((p) => p.id)).toEqual([forAgent?.id ?? ""]);
});
