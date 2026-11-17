import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  type AgentRun,
  APPROVALS_LEVELS,
  addChannelMember,
  agentCoAuthorOn,
  COMMIT_CO_AUTHOR_TOOL,
  createCoAuthorToolSource,
  postPersonMessage,
  type RunAuthority,
  type ToolContext,
  toolPolicy,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * ADR 0156: agents end their commits with their own line, on by default; a person asks any agent to turn it off (or
 * on again) for the whole workspace, and it is done at once, with nobody to approve it.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const runOf = async (triggerMessageId: string) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.triggerMessageId, triggerMessageId));
  if (!run) throw new Error("no run");
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  return run;
};

const ctxOf = (run: Pick<AgentRun, "id" | "agentId" | "channelId" | "triggerMessageId">) =>
  ({
    db: f.db,
    orgId: f.org.id,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    triggerMessageId: run.triggerMessageId,
  }) as ToolContext;

const call = async (action: string, ctx: ToolContext) => {
  const [tool] = await createCoAuthorToolSource().tools({} as ToolContext);
  if (!tool) throw new Error("no tool");
  return tool.execute({ action }, ctx);
};

const changes = () =>
  f.db
    .select()
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "organization.agent_co_author_changed")),
    );

describe(COMMIT_CO_AUTHOR_TOOL, () => {
  test("a member asks any agent: off for the whole workspace at once, audited once; on again the same way", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "@dev tira a linha de co-autor dos commits",
    });
    const ctx = ctxOf(await runOf(asked.id));
    expect((await call("status", ctx)).content).toStartWith("On:");

    const off = await call("off", ctx);
    expect(off.isError).toBeUndefined();
    expect(off.content).toStartWith("Done");
    expect(off.data).toEqual({ on: false });
    expect(await agentCoAuthorOn(f.db, f.org.id)).toBe(false);
    expect(await changes()).toMatchObject([
      {
        actorType: "agent",
        actorId: f.agent.id,
        onBehalfOfUserId: bia.id,
        runId: ctx.runId,
        channelId: f.general.id,
        details: { on: false },
      },
    ]);
    // Asked again: nothing to change, nothing more in the log.
    expect((await call("off", ctx)).content).toStartWith("It already was. Off:");
    expect(await changes()).toHaveLength(1);
    expect((await call("status", ctx)).content).toStartWith("Off:");

    expect((await call("on", ctx)).content).toStartWith("Done");
    expect(await agentCoAuthorOn(f.db, f.org.id)).toBe(true);
    expect((await changes()).map((c) => c.details)).toEqual([{ on: false }, { on: true }]);
    expect((await call("loud", ctx)).isError).toBe(true);
  });

  test("never the agent on its own: with nobody behind the run nothing changes, and status still answers", async () => {
    f = await setup();
    const ctx = ctxOf({ id: "", agentId: f.agent.id, channelId: f.general.id, triggerMessageId: "" });
    const refused = await call("off", ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("nothing changed");
    expect(await agentCoAuthorOn(f.db, f.org.id)).toBe(true);
    expect(await changes()).toEqual([]);
    expect((await call("status", ctx)).isError).toBeUndefined();
  });

  test("it asks nobody, whatever the agent's approvals level", () => {
    const tool = { name: COMMIT_CO_AUTHOR_TOOL, scope: "" };
    const runs: RunAuthority[] = [
      { kind: "person", personId: "user_ana" },
      { kind: "unattended", personId: null, reason: "agent" },
      { kind: "routine", personId: null, brief: null },
    ];
    for (const authority of runs) {
      for (const level of APPROVALS_LEVELS) {
        expect(toolPolicy(authority, tool, level)).toEqual({ action: "allow" });
      }
    }
  });
});
