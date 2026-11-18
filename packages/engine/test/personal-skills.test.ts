import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  agentSkillByName,
  agentSkillList,
  deleteSkill,
  enabledSkills,
  ForbiddenError,
  getSkill,
  insertMessage,
  listSkills,
  NotFoundError,
  saveSkill,
  setAgentSkills,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const deps = () => ({ db: f.db, blobs: f.artifactDeps.blobs });

const skill = (name: string, body = "# Steps\n1. Write short.") => ({
  name,
  description: "How I write e-mails.",
  body,
  metadata: {},
  source: "manual" as const,
});

/** A run of `@dev` answering `userId`'s message in general. */
async function runFor(userId: string) {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: "@dev help me",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** `@dev` belongs to a member: they install a personal skill, which goes on for their agent. */
async function memberWithSkill() {
  f = await setup({ skillTools: true });
  const member = await addMember(f.db, f.org.id, "member", "walter");
  await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
  const mine = await saveSkill(deps(), member.id, f.org.id, { ...skill("email-tone"), owner: member.id });
  return { member, mine };
}

describe("personal skills, split as the Vault splits (ADR 0144)", () => {
  test("any member installs one; it goes on for their own agents; a team skill stays for who manages agents", async () => {
    const { member, mine } = await memberWithSkill();
    expect(mine.ownerUserId).toBe(member.id);
    const on = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, mine.id));
    expect(on.map((r) => [r.agentId, r.enabled])).toEqual([[f.agent.id, true]]);
    await expect(saveSkill(deps(), member.id, f.org.id, skill("team-thing"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("only its person sees its text; an admin sees its name and person only, and may remove it", async () => {
    const { member, mine } = await memberWithSkill();
    const other = await addMember(f.db, f.org.id, "member", "nina");
    expect((await listSkills(f.db, other.id, f.org.id, { others: true })).map((s) => s.id)).not.toContain(mine.id);
    await expect(getSkill(f.db, other.id, f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);

    const seen = (await listSkills(f.db, f.owner.id, f.org.id, { others: true })).find((s) => s.id === mine.id);
    expect(seen).toMatchObject({ name: "email-tone", ownerUserId: member.id, description: "", agentsCount: 1 });
    expect((await listSkills(f.db, f.owner.id, f.org.id)).map((s) => s.id)).not.toContain(mine.id);
    await expect(getSkill(f.db, f.owner.id, f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      saveSkill(deps(), f.owner.id, f.org.id, { ...skill("email-tone", "changed"), owner: member.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect((await getSkill(f.db, member.id, f.org.id, mine.id)).body).toContain("Write short");
    await deleteSkill(f.db, f.owner.id, f.org.id, mine.id);
    await expect(getSkill(f.db, member.id, f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an admin turns it off for an agent, never on; its person turns it back on", async () => {
    const { member, mine } = await memberWithSkill();
    expect((await agentSkillList(f.db, f.owner.id, f.org.id, f.agent.id)).find((s) => s.id === mine.id)).toMatchObject({
      enabled: true,
      description: "",
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: mine.id, enabled: false }]);
    await expect(
      setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: mine.id, enabled: true }]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await setAgentSkills(f.db, member.id, f.org.id, f.agent.id, [{ skillId: mine.id, enabled: true }]);
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.name)).toEqual([]);
  });

  test("an agent uses it only on runs its person is behind, and theirs wins over a team skill of that name", async () => {
    const { member, mine } = await memberWithSkill();
    const team = await saveSkill(deps(), f.owner.id, f.org.id, skill("email-tone", "# Team tone"));
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: team.id, enabled: true }]);

    const theirs = await runFor(member.id);
    const others = await runFor(f.owner.id);
    expect((await enabledSkills(f.db, f.org.id, f.agent.id, theirs.id)).map((s) => s.id)).toEqual([mine.id]);
    expect((await enabledSkills(f.db, f.org.id, f.agent.id, others.id)).map((s) => s.id)).toEqual([team.id]);
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.id)).toEqual([team.id]);
    expect((await agentSkillByName(f.db, f.org.id, f.agent.id, "email-tone", theirs.id))?.id).toBe(mine.id);
    expect((await agentSkillByName(f.db, f.org.id, f.agent.id, "email-tone", others.id))?.id).toBe(team.id);
  });

  test("a skill an agent makes when a person asks is that person's, where the workspace has more than one", async () => {
    f = await setup({ skillTools: true });
    const member = await addMember(f.db, f.org.id, "member", "walter");
    const run = await runFor(member.id);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.triggerMessageId,
      triggerMessageId: run.triggerMessageId,
    };
    const r = await f.tools?.invoke(ctx, {
      toolUseId: "tu_personal",
      name: "create_skill",
      input: { name: "email-tone", description: "How Walter writes e-mails.", body: "# Steps\n1. Short." },
    });
    if (r?.type !== "result") throw new Error("expected a result");
    expect(r.output.isError).toBeFalsy();
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "email-tone"));
    expect(row?.ownerUserId).toBe(member.id);
    expect((await listSkills(f.db, f.owner.id, f.org.id)).map((s) => s.name)).not.toContain("email-tone");
  });
});
