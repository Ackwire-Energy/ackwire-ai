import { afterEach, describe, expect, test } from "bun:test";
import { MISSION_MCP_TOOLS, type ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  createMachinePairing,
  createMission,
  createMissionRunToolSource,
  grantScopes,
  issueRunToolToken,
  type MachineHub,
  postPersonMessage,
  redeemMachinePairing,
  revokeRunToolTokens,
  type ToolSource,
  verifyRunToolToken,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { missionRunner, pairedMachine, RUNNER, type TaskStartRequest } from "./mission-helpers";
import { fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

type McpTools = Extract<ServerFrame, { type: "mcp.tools" }>;
type McpResult = Extract<ServerFrame, { type: "mcp.result" }>;

/** A tool whose schema uses `$ref` and a top-level `oneOf` (as some MCP servers send). */
const refSource: ToolSource = {
  name: "ref-tools",
  tools: async () => [
    {
      name: "lookup",
      description: "Look something up",
      scope: "github:pr.read",
      inputSchema: {
        $defs: { id: { type: "string", minLength: 1 } },
        oneOf: [
          { type: "object", properties: { id: { $ref: "#/$defs/id" } }, required: ["id"] },
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        ],
      },
      execute: async () => ({ content: "found" }),
    },
  ],
};

/** A fake runner that can send bridge frames and wait for the answer. */
function bridgeRunner(hub: MachineHub) {
  const runner = missionRunner(hub);
  let n = 0;
  const wait = async <T extends ServerFrame>(pick: (s: ServerFrame) => s is T): Promise<T> => {
    for (let i = 0; i < 400; i++) {
      const found = runner.sent.find(pick);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no answer from the server");
  };
  return {
    ...runner,
    async list(token: string, taskId = "run"): Promise<McpTools> {
      const callId = `list-${++n}`;
      await runner.frame({ type: "mcp.list", callId, taskId, token });
      return wait((s): s is McpTools => s.type === "mcp.tools" && s.callId === callId);
    },
    async call(token: string, tool: string, args: Record<string, unknown>, taskId = "run"): Promise<McpResult> {
      const callId = `call-${++n}`;
      await runner.frame({ type: "mcp.call", callId, taskId, tool, args, token });
      return wait((s): s is McpResult => s.type === "mcp.result" && s.callId === callId);
    },
  };
}

const names = (r: McpTools) => (r.ok ? r.tools.map((t) => t.name).sort() : []);

async function runningRun(threadRootId?: string) {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "hi",
    ...(threadRootId ? { threadId: threadRootId } : {}),
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: threadRootId ?? msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

async function otherMachine() {
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const { code } = await createMachinePairing(deps, f.owner.id, f.org.id, { name: "Other" });
  return redeemMachinePairing(deps, { code, ...RUNNER, exec: true });
}

describe("runner MCP bridge (ADR 0032)", () => {
  async function connected() {
    const gh = fakeGithub();
    f = await setup({ machines: true, toolSources: [gh.source, refSource], reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    await grantScopes(f.db, f.org.id, f.agent.id, [
      { connectionId: null, scope: "github:pr.read" },
      { connectionId: null, scope: "github:pr.merge" },
    ]);
    const runner = bridgeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    return { gh, paired, runner };
  }

  test("tools/list returns the run's tools with the agent's scopes, schemas the CLIs accept", async () => {
    const { paired, runner } = await connected();
    const run = await runningRun();
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: run.id,
    });
    const listed = await runner.list(token);
    expect(listed.ok).toBe(true);
    // github:pr.write isn't granted: github_close_pr isn't listed.
    expect(names(listed)).toContain("github_get_pr");
    expect(names(listed)).toContain("github_merge_pr");
    expect(names(listed)).not.toContain("github_close_pr");
    // No mission here: no mission tools, and never Claude Code's prompt tool.
    expect(names(listed)).not.toContain("update_plan");
    expect(names(listed)).not.toContain("permission_prompt");
    const lookup = listed.ok ? listed.tools.find((t) => t.name === "lookup") : undefined;
    expect(JSON.stringify(lookup?.inputSchema)).not.toContain("$ref");
    expect(lookup?.inputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string", minLength: 1 }, name: { type: "string" } },
    });
    expect(lookup?.inputSchema.oneOf).toBeUndefined();
  });

  test("a call goes through the gateway: steps recorded; a gated call posts the card and pauses the run", async () => {
    const { gh, paired, runner } = await connected();
    const run = await runningRun();
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: run.id,
    });
    const read = await runner.call(token, "github_get_pr", { repo: "a/b", pr: 3 });
    expect(read).toMatchObject({ ok: true, text: "github_get_pr ok: a/b#3" });
    expect(gh.executed).toEqual([{ tool: "github_get_pr", input: { repo: "a/b", pr: 3 } }]);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result"]);

    // Bad input and tools the agent lacks: refused by the gateway, with codes.
    expect(await runner.call(token, "github_get_pr", { repo: "a/b" })).toMatchObject({
      ok: false,
      error: { code: "tool.invalid_input" },
    });
    expect(await runner.call(token, "github_close_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "tool.not_allowed" },
    });

    const merge = await runner.call(token, "github_merge_pr", { repo: "a/b", pr: 3 });
    expect(merge.ok && merge.text).toContain("Waiting for a person to approve");
    expect(gh.executed).toHaveLength(1);
    const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.id));
    expect(approval).toMatchObject({ tool: "github_merge_pr", status: "pending" });
    expect(approval?.messageId).not.toBeNull();
    const card = (await f.db.select().from(schema.messages)).find((m) => m.meta.approvalId === approval?.id);
    expect(card?.authorAgentId).toBe(f.agent.id);
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(after?.status).toBe("waiting_approval");
    // While it waits, the brain gets no more tools.
    expect(await runner.call(token, "github_get_pr", { repo: "a/b", pr: 4 })).toMatchObject({
      ok: false,
      error: { code: "bridge.run_waiting" },
    });
  });

  test("a token from another machine, of an ended run, revoked or unknown is refused", async () => {
    const { paired, runner } = await connected();
    const run = await runningRun();
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: run.id,
    });
    const other = await otherMachine();
    const intruder = bridgeRunner(f.machineHub as MachineHub);
    await intruder.hello(other.token);
    expect(await intruder.call(token, "github_get_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "bridge.wrong_machine" },
    });
    expect(await intruder.list(token)).toMatchObject({ ok: false, error: { code: "bridge.wrong_machine" } });
    expect(await runner.call(`agr_${"x".repeat(43)}`, "github_get_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "bridge.invalid_token" },
    });

    // Another run's token never acts for this one; an ended run's token is dead.
    const second = await runningRun();
    const secondToken = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: second.id,
    });
    expect((await verifyRunToolToken(f.db, paired.machineId, secondToken)).ok && true).toBe(true);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, second.id));
    expect(await runner.call(secondToken, "github_get_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "bridge.run_ended" },
    });
    const check = await verifyRunToolToken(f.db, paired.machineId, token);
    expect(check).toMatchObject({ ok: true, identity: { runId: run.id, machineId: paired.machineId } });

    await revokeRunToolTokens(f.db, { runId: run.id });
    expect(await runner.list(token)).toMatchObject({ ok: false, error: { code: "bridge.invalid_token" } });
  });
});

describe("mission tools through the bridge", () => {
  async function proposed() {
    f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    const runner = bridgeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const view = await createMission(f.missionDeps, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Build our mobile app",
      title: "Mobile app",
      repoDir: "app",
    });
    const plan = runner.started[0] as TaskStartRequest;
    return { view, runner, plan, paired };
  }

  test("a computer-brain run gets the mission tools only in its mission's thread", async () => {
    const { view, runner, paired } = await proposed();
    const inThread = await runningRun(view.threadId as string);
    const elsewhere = await runningRun();
    const tokenOf = (runId: string) =>
      issueRunToolToken(f.db, { orgId: f.org.id, agentId: f.agent.id, machineId: paired.machineId, runId });
    const there = names(await runner.list(await tokenOf(inThread.id)));
    expect(there).toEqual(expect.arrayContaining(["update_plan", "report", "ask_decision", "request_review"]));
    expect(there).not.toContain("send_to_mission");
    expect(there).not.toContain("permission_prompt");
    const outside = names(await runner.list(await tokenOf(elsewhere.id)));
    expect(outside).not.toContain("update_plan");
    expect(outside).not.toContain("report");
  });

  test("a computer-brain run's machine mission tools (start_task, upload_artifact, get_context) only with MISSIONS_ON_ENGINE", async () => {
    const { view, paired } = await proposed();
    const run = await runningRun(view.threadId as string);
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: view.threadId as string,
      triggerMessageId: run.triggerMessageId,
      bridge: { machineId: paired.machineId },
    };
    const { db: _db, ...deps } = f.missionDeps;
    const off = await createMissionRunToolSource({ ...deps, missionsOnEngine: false }).tools(ctx);
    // Flag off: the mission's main session is its executor task; the run is an ordinary run.
    expect(off.map((t) => t.name)).toEqual(["permission_prompt"]);
    const prompt = off[0];
    // Code's own rules decide (`runPermissionPrompt`), not the mission's command flow.
    const answer = await prompt?.execute({ tool_name: "Bash", input: { command: "npm install" } }, ctx);
    expect(answer?.content).toContain("may not run commands");
    expect(answer?.content).not.toContain("plan isn't approved");
    const on = await createMissionRunToolSource({ ...deps, missionsOnEngine: true }).tools(ctx);
    expect(on.map((t) => t.name).sort()).toEqual(["get_context", "permission_prompt", "start_task", "upload_artifact"]);
  });

  test("a mission task's token: its own tools (permission_prompt included), bound to that task and machine", async () => {
    const { runner, plan, paired } = await proposed();
    const token = plan.mission?.mcpToken as string;
    expect(token).toMatch(/^agr_/);
    const listed = await runner.list(token, plan.taskId);
    expect(names(listed)).toEqual(MISSION_MCP_TOOLS.map((t) => t.name).sort());

    const reported = await runner.call(token, "report", { summary: "Mapped the repo" }, plan.taskId);
    expect(reported).toMatchObject({ ok: true });
    expect(reported.ok && reported.text).toContain("Reported");
    // Same refusal codes as before the bridge.
    expect(await runner.call(token, "report", { nope: 1 }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "mission.invalid_input" },
    });
    // A task's executor never gets the agent's other tools.
    expect(await runner.call(token, "propose_mission", { title: "x", goal: "y" }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "mission.unknown_tool" },
    });
    // The legacy path (an older runner: no token) still works.
    expect(await runner.mcp(plan.taskId, "report", { summary: "Still here" })).toMatchObject({ ok: true });

    const other = await otherMachine();
    const intruder = bridgeRunner(f.machineHub as MachineHub);
    await intruder.hello(other.token);
    expect(await intruder.call(token, "report", { summary: "hi" }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "bridge.wrong_machine" },
    });

    await runner.done(plan.taskId);
    for (let i = 0; i < 100; i++) {
      const [task] = await f.db
        .select()
        .from(schema.machineTasks)
        .where(and(eq(schema.machineTasks.id, plan.taskId), eq(schema.machineTasks.machineId, paired.machineId)));
      if (task?.endedAt) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await runner.call(token, "report", { summary: "late" }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "mission.task_ended" },
    });
  });
});
