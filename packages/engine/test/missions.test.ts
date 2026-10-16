import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  approveProvisionalDecisions,
  buildRunContext,
  chooseDecision,
  closeMission,
  createMachinePairing,
  createMission,
  decideApproval,
  decideReview,
  decideSuggestion,
  drainOutbox,
  getMission,
  getMissionFiles,
  grantScopes,
  type MachineHub,
  MISSION_RULES,
  missionSummary,
  opineDecision,
  pauseMission,
  postPersonMessage,
  redeemMachinePairing,
  requestFilesSync,
  START_PROMPT,
  setAgentComputerTarget,
  setParticipant,
  startMachineTask,
  startMission,
  stopMission,
  syncMissionFiles,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];
const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};
const deps = () => ({ db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" });
const md = () => f.missionDeps;

type Request = Extract<ServerFrame, { type: "request" }>;
type TaskStartRequest = Extract<Request, { op: "task.start" }>;
type McpResult = Extract<ServerFrame, { type: "mcp.result" }>;

/** A runner over an in-memory socket: tasks, files in memory (`read`/`write`), and MCP calls. */
function missionRunner(hub: MachineHub) {
  const sent: ServerFrame[] = [];
  const started: TaskStartRequest[] = [];
  const files = new Map<string, string>();
  const canceled: string[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          started.push(frame);
          return ok({
            taskId: frame.taskId,
            pid: 100 + started.length,
            startedAt: new Date().toISOString(),
            cwd: frame.branch ? `.worktrees/${frame.taskId}` : (frame.cwd ?? ""),
            ...(frame.branch ? { branch: frame.branch } : {}),
            command: "claude -p --output-format stream-json",
          });
        }
        if (frame.op === "task.cancel") {
          canceled.push(frame.taskId);
          return ok({ canceled: true });
        }
        if (frame.op === "read") {
          const text = files.get(frame.path);
          return ok(
            text === undefined
              ? { base64: null, size: 0 }
              : { base64: Buffer.from(text).toString("base64"), size: text.length },
          );
        }
        if (frame.op === "write") {
          files.set(frame.path, Buffer.from(frame.base64, "base64").toString("utf8"));
          return ok({ size: frame.base64.length });
        }
        return ok({});
      }, 1);
    },
    close() {
      void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  let calls = 0;
  return {
    sent,
    started,
    files,
    canceled,
    frame: (frame: Record<string, unknown>) => reply(frame),
    hello: (token: string) => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true })),
    /** The executor of `taskId` calls one of our MCP tools; resolves with the server's answer. */
    async mcp(taskId: string, tool: string, args: Record<string, unknown>): Promise<McpResult> {
      const callId = `call-${++calls}`;
      await reply({ type: "mcp.call", callId, taskId, tool, args });
      for (let i = 0; i < 400; i++) {
        const found = sent.find((s): s is McpResult => s.type === "mcp.result" && s.callId === callId);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`no mcp.result for ${tool}`);
    },
    done: (taskId: string, extra: Record<string, unknown> = {}) =>
      reply({ type: "task.done", taskId, exitCode: 0, seconds: 60, ...extra }),
  };
}

async function pairedMachine() {
  const { code } = await createMachinePairing(deps(), f.owner.id, f.org.id, { name: "MacBook" });
  const paired = await redeemMachinePairing(deps(), { code, ...RUNNER, exec: true });
  await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
  await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
  return paired;
}

const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;
const ok = (r: McpResult) => {
  if (!r.ok) throw new Error(`mcp refused: ${r.error.code} ${r.error.message}`);
  return r.text;
};

/** A mission made from the web (`/mission`), its runner connected, its plan task running. */
async function proposed(options: { reply?: NonNullable<Parameters<typeof setup>[0]>["reply"] } = {}) {
  f = await setup({ machines: true, missionTools: true, reply: options.reply ?? (() => ({ chunks: ["ok"] })) });
  const paired = await pairedMachine();
  const runner = missionRunner(f.machineHub as MachineHub);
  await runner.hello(paired.token);
  const view = await createMission(md(), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    channelId: f.general.id,
    goal: "Build our mobile app",
    title: "Mobile app",
    repoDir: "app",
  });
  const plan = runner.started[0] as TaskStartRequest;
  return { view, runner, plan, paired };
}

describe("missions (ADR 0029)", () => {
  test("the agent proposes (plan mode on the machine, plan card); only the owner starts; the start waits for the plan turn", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (_req, n) =>
        n === 1
          ? {
              chunks: ["Planning it."],
              toolUses: [{ name: "propose_mission", input: { title: "Mobile app", goal: "Build our mobile app" } }],
            }
          : { chunks: ["Claude Code is planning; press Start when the plan looks right."] },
    });
    const paired = await pairedMachine();
    const runner = missionRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev build our mobile app with Claude Code",
    });
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    expect(mission).toMatchObject({
      status: "proposed",
      ownerId: f.owner.id,
      threadRootId: ask.id,
      title: "Mobile app",
    });
    const plan = runner.started[0] as TaskStartRequest;
    expect(plan).toMatchObject({ executor: "claude", session: mission.mainSessionId, mission: { id: mission.id } });
    expect(plan.mission?.rules).toBe(MISSION_RULES);
    expect(plan.prompt).toContain("PLAN MODE");
    const thread = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, ask.id));
    const card = thread.find((m) => m.meta.missionPlan);
    expect(card?.meta).toMatchObject({ missionPlan: { missionId: mission.id }, bodyCode: "mission_plan" });
    expect(card?.authorAgentId).toBe(f.agent.id);

    // A decider can't press Start; the owner can.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await setParticipant(md(), f.owner.id, f.org.id, mission.id, { userId: bia.id, role: "decide" });
    await expect(startMission(md(), bia.id, f.org.id, mission.id)).rejects.toMatchObject({ code: "mission.not_owner" });
    const started = await startMission(md(), f.owner.id, f.org.id, mission.id);
    expect(started.status).toBe("active");
    // The plan turn still runs: "proceed" waits for it, then goes out as a resume of the main session.
    expect(runner.started).toHaveLength(1);
    expect((await missionRow()).inbox).toHaveLength(1);
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    const proceed = runner.started[1] as TaskStartRequest;
    expect(proceed).toMatchObject({ session: mission.mainSessionId, resume: true, prompt: START_PROMPT });
    expect((await missionRow()).inbox).toHaveLength(0);
    // A mission task's end wakes no agent run.
    expect((await f.db.select().from(schema.agentRuns)).length).toBe(1);
  });

  test("update_plan versions the plan; changes after the first post one line; mission brief in the run's context", async () => {
    const { view, runner, plan } = await proposed();
    const first = ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "nav", title: "Navigation", status: "doing" },
          { id: "auth", title: "Sign-in", status: "todo" },
        ],
      }),
    );
    expect(first).toContain("version 1");
    let lines = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId));
    expect(lines.some((m) => m.meta.missionPlanChange)).toBe(false);
    ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "nav", title: "Navigation", status: "done" },
          { id: "build", title: "Dev build", status: "todo" },
        ],
      }),
    );
    lines = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId));
    const change = lines.find((m) => m.meta.missionPlanChange);
    expect(change?.meta.missionPlanChange).toMatchObject({
      version: 2,
      added: [{ id: "build", title: "Dev build" }],
      removed: [{ id: "auth", title: "Sign-in" }],
      changed: [{ id: "nav", from: "doing", to: "done" }],
    });
    expect((await missionRow()).planDone).toBe(1);
    const versions = await f.db.select().from(schema.missionPlanVersions);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);

    // The owner asks the agent in the thread: its context has the brief.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev how is it going?",
      threadId: view.threadId,
    });
    await drainOutbox(f.db, f.handlers);
    const system = JSON.stringify(f.provider.calls.at(-1)?.request.system ?? "");
    expect(system).toContain("# Mission in this thread");
    expect(system).toContain("Plan: 1 of 2 done");
    expect(system).toContain("send_to_mission");
  });

  test("roles: a non-participant's or commenter's mention is a suggestion (no run); a decider's starts a run; accept forwards it", async () => {
    const { view, runner, plan } = await proposed();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const duda = await addMember(f.db, f.org.id, "member", "duda");
    for (const u of [bia, caio, duda]) {
      await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
    }
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: caio.id, role: "comment" });
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: duda.id, role: "decide" });
    const post = (userId: string, body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, {
        body,
        threadId: view.threadId,
      });

    const fromBia = await post(bia.id, "@dev add a dark mode");
    const fromCaio = await post(caio.id, "@dev use tabs");
    expect(fromBia.meta.missionSuggestion).toEqual({ status: "pending", missionId: view.id });
    expect(fromCaio.meta.missionSuggestion).toEqual({ status: "pending", missionId: view.id });
    await drainOutbox(f.db, f.handlers);
    const runs = () => f.db.select().from(schema.agentRuns);
    expect((await runs()).length).toBe(0);
    const fromDuda = await post(duda.id, "@dev what's the status?");
    expect(fromDuda.meta.missionSuggestion).toBeUndefined();
    expect((await runs()).filter((r) => r.triggerMessageId === fromDuda.id)).toHaveLength(1);
    expect((await getMission(md(), bia.id, f.org.id, view.id)).role).toBe("none");

    // A commenter can't decline; the owner accepts: the main session gets it (queued while its plan turn runs).
    await expect(decideSuggestion(md(), caio.id, f.org.id, view.id, fromBia.id, "declined")).rejects.toMatchObject({
      code: "mission.not_allowed",
    });
    await decideSuggestion(md(), f.owner.id, f.org.id, view.id, fromCaio.id, "declined");
    await decideSuggestion(md(), f.owner.id, f.org.id, view.id, fromBia.id, "accepted");
    expect((await missionRow()).inbox[0]?.text).toContain("Suggestion from bia, accepted by ana: @dev add a dark mode");
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    expect(runner.started.at(-1)?.prompt).toContain("Suggestion from bia");
  });

  test("blocking decision: the session waits; commenters only give opinions; the choice resumes the asking session", async () => {
    const { view, runner, plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: caio.id });
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: caio.id, role: "comment" });
    const text = ok(
      await runner.mcp(plan.taskId, "ask_decision", {
        question: "Navigation style?",
        options: ["Tabs", "Drawer"],
        recommendation: "Tabs",
        why: "Fewer taps",
        blocking: true,
      }),
    );
    expect(text).toBe("Recorded. Stop now and wait; you'll be resumed with the decision.");
    const [decision] = await f.db.select().from(schema.missionDecisions);
    expect(decision).toMatchObject({ status: "pending", sessionId: plan.session, taskId: plan.taskId });
    const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.missionDecision,
    );
    expect(card?.meta.missionDecision).toEqual({ id: decision?.id, missionId: view.id });
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    // The main session's "proceed" turn (queued by Start) went out; it ends too.
    await runner.done((runner.started.at(-1) as TaskStartRequest).taskId);
    await drainOutbox(f.db, f.handlers);
    const before = runner.started.length;

    const id = decision?.id as string;
    await expect(chooseDecision(md(), caio.id, f.org.id, view.id, id, "Tabs")).rejects.toMatchObject({
      code: "mission.not_allowed",
    });
    const opined = await opineDecision(md(), caio.id, f.org.id, view.id, id, "Tabs");
    expect(opined.opinions).toEqual([{ userId: caio.id, option: "Tabs", at: expect.any(String) }]);
    const taken = await chooseDecision(md(), f.owner.id, f.org.id, view.id, id, "Drawer");
    expect(taken).toMatchObject({ status: "taken", chosen: "Drawer", chosenBy: f.owner.id });
    const resumed = runner.started[before] as TaskStartRequest;
    expect(resumed).toMatchObject({
      session: plan.session,
      resume: true,
      prompt: "Decision: Navigation style? → Drawer (by ana)",
      cwd: "app",
    });
  });

  test("provisional decisions go on with the recommendation and are approved together", async () => {
    const { view, runner, plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const text = ok(
      await runner.mcp(plan.taskId, "ask_decision", {
        question: "Icon set?",
        options: ["Lucide", "Phosphor"],
        recommendation: "Phosphor",
        blocking: false,
      }),
    );
    expect(text).toBe("Recorded as provisional: continue with your recommendation.");
    const [d] = await f.db.select().from(schema.missionDecisions);
    expect(d).toMatchObject({ status: "provisional", chosen: "Phosphor" });
    const before = runner.started.length;
    const approved = await approveProvisionalDecisions(md(), f.owner.id, f.org.id, view.id);
    expect(approved.map((x) => x.status)).toEqual(["taken"]);
    expect(runner.started.length).toBe(before);
  });

  test("reviews: approve or ask for changes resumes the session with the outcome", async () => {
    const { view, runner, plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    const main = runner.started.at(-1) as TaskStartRequest;
    ok(await runner.mcp(main.taskId, "request_review", { title: "Navigation prototypes", summary: "Three screens" }));
    const [review] = await f.db.select().from(schema.missionReviews);
    const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.missionReview,
    );
    expect(card?.meta.missionReview).toEqual({ id: review?.id, missionId: view.id });
    await runner.done(main.taskId);
    await drainOutbox(f.db, f.handlers);
    await expect(
      decideReview(md(), f.owner.id, f.org.id, view.id, review?.id as string, { outcome: "changes_requested" }),
    ).rejects.toMatchObject({ code: "mission.review_note_required" });
    const out = await decideReview(md(), f.owner.id, f.org.id, view.id, review?.id as string, {
      outcome: "changes_requested",
      note: "Bigger buttons",
    });
    expect(out.status).toBe("changes_requested");
    expect(runner.started.at(-1)?.prompt).toBe('Changes requested on "Navigation prototypes" (by ana): Bigger buttons');
  });

  test("request_approval creates an ADR 0015 approval; deciding it resumes the session", async () => {
    const { view, runner, plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const text = ok(
      await runner.mcp(plan.taskId, "request_approval", { action: "merge", target: "PR #12", detail: "Navigation" }),
    );
    expect(text).toContain("Approval requested");
    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({
      runId: null,
      missionId: view.id,
      missionTaskId: plan.taskId,
      status: "pending",
      title: "Merge PR #12",
      ownerUserId: f.owner.id,
    });
    const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.approvalId,
    );
    expect(card?.meta.approvalId).toBe(approval?.id);
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    await runner.done((runner.started.at(-1) as TaskStartRequest).taskId);
    await drainOutbox(f.db, f.handlers);
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id as string, {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect(runner.started.at(-1)?.prompt).toBe("Approval for Merge PR #12: approved by ana. Go ahead.");
  });

  test("pause refuses new tasks (mission.paused); stop cancels the running ones", async () => {
    const { view, runner, plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const started = ok(
      await runner.mcp(plan.taskId, "start_task", { title: "Navigation", prompt: "Build the tabs", branch: "nav" }),
    );
    expect(started).toContain("on branch nav");
    const item = runner.started.at(-1) as TaskStartRequest;
    expect(item).toMatchObject({ branch: "nav", cwd: "app", mission: { id: view.id } });
    expect(item.session).not.toBe(plan.session);
    await pauseMission(md(), f.owner.id, f.org.id, view.id);
    const refused = await runner.mcp(plan.taskId, "start_task", { title: "Auth", prompt: "Sign-in", branch: "auth" });
    expect(refused).toMatchObject({ ok: false, error: { code: "mission.paused" } });
    const stopped = await stopMission(md(), f.owner.id, f.org.id, view.id);
    expect(stopped.canceledTasks).toBe(2);
    expect(runner.canceled.sort()).toEqual([plan.taskId, item.taskId].sort());
  });

  test("mcp.call is refused for a task of another machine or with no mission", async () => {
    const { runner, plan } = await proposed();
    const plain = await startMachineTask(
      { db: f.db, pubsub: f.pubsub, call: (f.machineHub as MachineHub).call },
      {
        orgId: f.org.id,
        agent: { id: f.agent.id, handle: "dev" },
        machineId: (await missionRow()).machineId as string,
        protocol: MACHINE_PROTOCOL_VERSION,
        machineName: "MacBook",
        channelId: f.general.id,
        threadRootId: null,
        runId: null,
        requestedByUserId: f.owner.id,
        title: "Plain",
        executor: "shell",
        command: "true",
      },
    );
    expect(await runner.mcp(plain.id, "report", { summary: "hi" })).toMatchObject({
      ok: false,
      error: { code: "mission.not_allowed" },
    });
    // Another computer of the org presenting the mission's task id.
    const { code } = await createMachinePairing(deps(), f.owner.id, f.org.id, { name: "Other" });
    const other = await redeemMachinePairing(deps(), { code, ...RUNNER, exec: true });
    const intruder = missionRunner(f.machineHub as MachineHub);
    await intruder.hello(other.token);
    expect(await intruder.mcp(plan.taskId, "report", { summary: "hi" })).toMatchObject({
      ok: false,
      error: { code: "mission.not_allowed" },
    });
    expect(await runner.mcp(plan.taskId, "report", { nope: 1 })).toMatchObject({
      ok: false,
      error: { code: "mission.invalid_input" },
    });
    expect(ok(await runner.mcp(plan.taskId, "report", { summary: "Mapped the repo @ana" }))).toContain("Reported");
    const report = (await f.db.select().from(schema.messages)).find((m) => m.meta.missionReport);
    expect(report?.mentionedUserIds).toEqual([]);
    expect(report?.meta.missionReport).toMatchObject({ taskId: plan.taskId, computer: "MacBook", main: true });
  });

  test(".agentes files: written to the machine; an edit there is recorded and overwritten; notes come back after a task", async () => {
    const { view, runner, plan } = await proposed();
    ok(await runner.mcp(plan.taskId, "update_plan", { items: [{ id: "nav", title: "Navigation", status: "doing" }] }));
    await syncMissionFiles(md(), view.id);
    const mission = runner.files.get("app/.agentes/mission.md") ?? "";
    expect(mission).toContain("# Mission: Mobile app");
    expect(mission).toContain("- [~] Navigation");
    expect(mission).toContain("agentes.request_approval");
    expect(runner.files.get("app/.agentes/decisions.md")).toContain("# Decisions: Mobile app");

    runner.files.set("app/.agentes/mission.md", `${mission}\nlocal note by hand\n`);
    await requestFilesSync(f.db, await missionRow());
    await syncMissionFiles(md(), view.id);
    expect(runner.files.get("app/.agentes/mission.md")).toBe(mission);
    const files = await getMissionFiles(md(), f.owner.id, f.org.id, view.id);
    expect(files.editedOnMachine[0]).toMatchObject({ name: "mission.md", diff: "+ local note by hand" });

    runner.files.set("app/.agentes/notes.md", "Expo works; next: auth.");
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    const notes = (await getMissionFiles(md(), f.owner.id, f.org.id, view.id)).files.find((x) => x.name === "notes.md");
    expect(notes).toMatchObject({ content: "Expo works; next: auth.", source: "machine" });
  });

  test("summary from the database; closing with saveToWiki makes a page", async () => {
    const { view, runner, plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "a", title: "Navigation", status: "done" },
          { id: "b", title: "Sign-in", status: "waiting_you" },
        ],
      }),
    );
    const summary = await missionSummary(md(), f.owner.id, f.org.id, view.id);
    expect(summary.text).toContain("Plan: 1 of 2 done, 1 waiting for you.");
    expect(summary.plan).toEqual({ done: 1, total: 2, doing: 0, waiting: 1 });
    const closed = await closeMission(md(), f.owner.id, f.org.id, view.id, { outcome: "done", saveToWiki: true });
    expect(closed.status).toBe("done");
    const [page] = await f.db.select().from(schema.wikiPages);
    expect(page?.title).toBe("Mobile app: decisions and lessons");
    expect(closed.wikiPageId).toBe(page?.id ?? null);
    expect(await runner.mcp(plan.taskId, "report", { summary: "late" })).toMatchObject({
      ok: false,
      error: { code: "mission.closed" },
    });
  });

  test("buildRunContext has no mission block outside a mission's thread", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev hi",
    });
    const [run] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.triggerMessageId, ask.id)));
    const agent = (await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id)))[0];
    const ctx = await buildRunContext(
      f.db,
      run as typeof schema.agentRuns.$inferSelect,
      agent as typeof schema.agents.$inferSelect,
      {
        maxMessages: 10,
      },
    );
    expect(ctx.system.map((b) => b.text).join("\n")).not.toContain("# Mission in this thread");
  });
});
