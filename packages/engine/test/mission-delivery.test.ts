import { afterEach, describe, expect, test } from "bun:test";
import { userTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  acceptDelivery,
  addChannelMember,
  checkDeliveryItem,
  checkMissionDone,
  createMission,
  decideCommand,
  drainOutbox,
  getMission,
  latestPlan,
  listDeliveries,
  listMissions,
  listThreads,
  type MachineHub,
  pauseMission,
  postPersonMessage,
  requestDeliveryChanges,
  setCommandApproval,
  setParticipant,
  startMission,
  stripToolNames,
  updatePlan,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { type McpResult, missionRunner, pairedMachine, type TaskStartRequest } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const md = () => f.missionDeps;
const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;
const deliveries = () => f.db.select().from(schema.missionDeliveries);
const threadMessages = (threadId: string) =>
  f.db.select().from(schema.messages).where(eq(schema.messages.threadId, threadId));
const ok = (r: McpResult) => {
  if (!r.ok) throw new Error(`mcp refused: ${r.error.code} ${r.error.message}`);
  return r.text;
};

/** A started Claude Code mission: the plan turn ended, the main session works on "proceed". */
async function started() {
  f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
  const paired = await pairedMachine(f);
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
  await startMission(md(), f.owner.id, f.org.id, view.id);
  await runner.done(plan.taskId);
  await drainOutbox(f.db, f.handlers);
  const main = runner.started.at(-1) as TaskStartRequest;
  return { view, runner, main };
}

/** A person in #general who decides in the mission. */
async function decider(missionId: string, name = "bia") {
  const user = await addMember(f.db, f.org.id, "member", name);
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: user.id });
  await setParticipant(md(), f.owner.id, f.org.id, missionId, { userId: user.id, role: "decide" });
  return user;
}

describe("plan items never carry tool names", () => {
  test("stripToolNames removes known tool names with their connecting words, and keeps everything else", () => {
    expect(stripToolNames("Enviar capturas via upload_artifact")).toBe("Enviar capturas");
    expect(stripToolNames("Pedir revisão (request_review)")).toBe("Pedir revisão");
    expect(stripToolNames("Revisar telas e chamar `request_review`")).toBe("Revisar telas");
    expect(stripToolNames("Subir build pelo `start_task`")).toBe("Subir build");
    expect(stripToolNames("Call complete_mission() with the summary")).toBe("with the summary");
    expect(stripToolNames("Login, upload_file, testes")).toBe("Login, testes");
    // One-word names only as code; plain words stay.
    expect(stripToolNames("Escrever o report final")).toBe("Escrever o report final");
    expect(stripToolNames("Usar `report` no fim")).toBe("Usar no fim");
    // Unknown snake_case is not ours to remove.
    expect(stripToolNames("Ajustar user_id no login")).toBe("Ajustar user_id no login");
    // Nothing left: the original without backticks.
    expect(stripToolNames("`upload_artifact`")).toBe("upload_artifact");
    expect(stripToolNames("request_review")).toBe("request_review");
  });

  test("update_plan strips them server side (MCP)", async () => {
    const { runner, main } = await started();
    ok(
      await runner.mcp(main.taskId, "update_plan", {
        items: [
          { id: "a", title: "Telas via upload_artifact", status: "doing" },
          { id: "b", title: "Revisão (request_review)", status: "todo" },
        ],
      }),
    );
    const plan = await latestPlan(f.db, (await missionRow()).id);
    expect(plan?.items.map((i) => i.title)).toEqual(["Telas", "Revisão"]);
  });
});

describe("mission delivery and awaiting_close (ADR 0029)", () => {
  test("every item done and nothing running: awaiting_close with an automatic card; a person's message makes it active again", async () => {
    const { view, runner, main } = await started();
    ok(
      await runner.mcp(main.taskId, "update_plan", {
        items: [
          { id: "nav", title: "Navigation", status: "done" },
          { id: "old", title: "Drawer", status: "dropped" },
        ],
      }),
    );
    // The main session still works: not yet.
    expect((await missionRow()).status).toBe("active");
    await runner.done(main.taskId);
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).status).toBe("awaiting_close");
    const [auto] = await deliveries();
    expect(auto).toMatchObject({ auto: true, status: "pending", summary: "", checklist: [] });
    const card = (await threadMessages(view.threadId)).find((m) => m.meta.missionDelivery);
    expect(card?.meta).toMatchObject({
      missionDelivery: { missionId: view.id, id: auto?.id },
      bodyCode: "mission_all_done",
    });
    expect(card?.authorAgentId).toBe(f.agent.id);
    expect(auto?.messageId).toBe(card?.id ?? null);

    // Waiting for the owner (open, waiting for you; not for someone who only reads).
    const list = await listMissions(md(), f.owner.id, f.org.id, { status: "open" });
    expect(list.missions.map((m) => m.id)).toEqual([view.id]);
    expect(list.counts).toMatchObject({ active: 1, waitingYou: 1 });
    expect((await listMissions(md(), f.owner.id, f.org.id, { status: "waiting_you" })).missions).toHaveLength(1);
    expect((await getMission(md(), f.owner.id, f.org.id, view.id)).pending.deliveries).toBe(1);
    const reader = await addMember(f.db, f.org.id, "member", "rui");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: reader.id });
    expect((await getMission(md(), reader.id, f.org.id, view.id)).pending.deliveries).toBe(0);
    const row = async (userId: string) =>
      (await listThreads(f.db, userId, { orgId: f.org.id, tab: "missions" })).threads.find(
        (x) => x.mission?.id === view.id,
      )?.mission;
    expect((await row(f.owner.id))?.status).toBe("awaiting_close");
    expect((await row(f.owner.id))?.waitingYou).toBe(((await row(reader.id))?.waitingYou ?? 0) + 1);

    // Idempotent.
    expect(await checkMissionDone(md(), view.id)).toBeNull();
    expect(await deliveries()).toHaveLength(1);

    // The owner writes in the thread: new work.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "one more thing: dark mode",
      threadId: view.threadId,
    });
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).status).toBe("active");
    // Done again: back to waiting, with the same card (no second one).
    await checkMissionDone(md(), view.id);
    expect((await missionRow()).status).toBe("awaiting_close");
    expect(await deliveries()).toHaveLength(1);
  });

  test("a plan item reopened brings it back to active; pause works from awaiting_close", async () => {
    const { view, runner, main } = await started();
    ok(await runner.mcp(main.taskId, "update_plan", { items: [{ id: "nav", title: "Navigation", status: "done" }] }));
    await runner.done(main.taskId);
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).status).toBe("awaiting_close");
    await updatePlan(md(), await missionRow(), {
      items: [
        { id: "nav", title: "Navigation", status: "done" },
        { id: "dark", title: "Dark mode", status: "todo" },
      ],
      source: "executor",
    });
    expect((await missionRow()).status).toBe("active");
    await updatePlan(md(), await missionRow(), {
      items: [
        { id: "nav", title: "Navigation", status: "done" },
        { id: "dark", title: "Dark mode", status: "done" },
      ],
      source: "executor",
    });
    await checkMissionDone(md(), view.id);
    expect((await missionRow()).status).toBe("awaiting_close");
    const paused = await pauseMission(md(), f.owner.id, f.org.id, view.id);
    expect(paused.status).toBe("paused");
  });

  test("complete_mission: the delivery card with the checklist; a newer one supersedes; per-person checks; Pedir ajustes resumes the main session", async () => {
    const { view, runner, main } = await started();
    ok(await runner.mcp(main.taskId, "update_plan", { items: [{ id: "nav", title: "Navigation", status: "done" }] }));
    // Only the main session hands the mission over.
    ok(await runner.mcp(main.taskId, "start_task", { title: "Icons", prompt: "Draw icons", branch: "icons" }));
    const item = runner.started.at(-1) as TaskStartRequest;
    expect(ok(await runner.mcp(item.taskId, "complete_mission", { summary: "All done" }))).toContain(
      "Only the mission's main session",
    );
    expect(await deliveries()).toHaveLength(0);
    // Its end waits for the main session, which still works.
    await runner.done(item.taskId);
    await drainOutbox(f.db, f.handlers);
    expect(await deliveries()).toHaveLength(0);

    const first = ok(await runner.mcp(main.taskId, "complete_mission", { summary: "First take" }));
    expect(first).toBe("Delivered. Stop now and wait for the person to check it.");
    const text = ok(
      await runner.mcp(main.taskId, "complete_mission", {
        summary: "The app builds; screens for sign-in and the tabs.",
        checklist: ["Open the app on your phone", "Sign in with Google"],
      }),
    );
    expect(text).toBe("Delivered. Stop now and wait for the person to check it.");
    expect((await missionRow()).status).toBe("awaiting_close");
    const list = await listDeliveries(md(), f.owner.id, f.org.id, view.id);
    expect(list.map((d) => d.status)).toEqual(["pending", "superseded"]);
    const delivery = list[0];
    expect(delivery).toMatchObject({
      auto: false,
      summary: "The app builds; screens for sign-in and the tabs.",
      checklist: [
        { id: "c1", text: "Open the app on your phone", checkedBy: [] },
        { id: "c2", text: "Sign in with Google", checkedBy: [] },
      ],
    });
    const card = (await threadMessages(view.threadId)).find(
      (m) => (m.meta.missionDelivery as { id?: string } | undefined)?.id === delivery?.id,
    );
    expect(card?.meta.bodyCode).toBe("mission_delivery");
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "mission.tool_complete_mission"));
    expect(audits.length).toBeGreaterThanOrEqual(2);

    // Each person checks on their own; someone who only comments can't.
    const bia = await decider(view.id);
    await checkDeliveryItem(md(), f.owner.id, f.org.id, view.id, delivery?.id as string, "c1", true);
    const both = await checkDeliveryItem(md(), bia.id, f.org.id, view.id, delivery?.id as string, "c1", true);
    expect(both.checklist[0]?.checkedBy.sort()).toEqual([bia.id, f.owner.id].sort());
    const undone = await checkDeliveryItem(md(), bia.id, f.org.id, view.id, delivery?.id as string, "c1", false);
    expect(undone.checklist[0]?.checkedBy).toEqual([f.owner.id]);
    await expect(
      checkDeliveryItem(md(), f.owner.id, f.org.id, view.id, delivery?.id as string, "nope", true),
    ).rejects.toMatchObject({ code: "mission.delivery_item_not_found" });
    const cai = await addMember(f.db, f.org.id, "member", "cai");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: cai.id });
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: cai.id, role: "comment" });
    await expect(
      checkDeliveryItem(md(), cai.id, f.org.id, view.id, delivery?.id as string, "c2", true),
    ).rejects.toMatchObject({ code: "mission.not_allowed" });

    // The main session ends and hears the item's news (the mission's own notice: still waiting to be concluded).
    await runner.done(main.taskId);
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).status).toBe("awaiting_close");
    const news = runner.started.at(-1) as TaskStartRequest;
    expect(news.session).toBe(main.session);
    expect(news.prompt).toContain('"Icons"');
    await runner.done(news.taskId);
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).status).toBe("awaiting_close");
    expect(await deliveries()).toHaveLength(2);

    // "Pedir ajustes": active again, the note goes to the main session.
    await expect(
      requestDeliveryChanges(md(), f.owner.id, f.org.id, view.id, delivery?.id as string, { note: "  " }),
    ).rejects.toMatchObject({ code: "mission.delivery_note_required" });
    const after = await requestDeliveryChanges(md(), f.owner.id, f.org.id, view.id, delivery?.id as string, {
      note: "Bigger buttons",
    });
    expect(after.status).toBe("active");
    expect(runner.started.at(-1)?.prompt).toBe("Changes requested on the delivery (by ana): Bigger buttons");
    const [changed] = await listDeliveries(md(), f.owner.id, f.org.id, view.id);
    expect(changed).toMatchObject({ status: "changes_requested", note: "Bigger buttons", decidedBy: f.owner.id });
    await expect(acceptDelivery(md(), f.owner.id, f.org.id, view.id, delivery?.id as string)).rejects.toMatchObject({
      code: "mission.delivery_decided",
    });
  });

  test("Concluir missão (a decider can): done, with the lessons in the wiki", async () => {
    const { view, runner, main } = await started();
    ok(await runner.mcp(main.taskId, "update_plan", { items: [{ id: "nav", title: "Navigation", status: "done" }] }));
    ok(await runner.mcp(main.taskId, "complete_mission", { summary: "Shipped", checklist: ["Try it"] }));
    const [delivery] = await listDeliveries(md(), f.owner.id, f.org.id, view.id);
    const bia = await decider(view.id);
    const closed = await acceptDelivery(md(), bia.id, f.org.id, view.id, delivery?.id as string, { saveToWiki: true });
    expect(closed.status).toBe("done");
    const [page] = await f.db.select().from(schema.wikiPages);
    expect(page?.title).toBe("Mobile app: decisions and lessons");
    expect(closed.wikiPageId).toBe(page?.id ?? null);
    const [accepted] = await listDeliveries(md(), f.owner.id, f.org.id, view.id);
    expect(accepted).toMatchObject({ status: "accepted", saveToWiki: true, decidedBy: bia.id });
    // Its main session was canceled with the mission.
    expect(runner.canceled).toContain(main.taskId);
  });

  test("complete_mission is rate limited (5 an hour per task) and refused before Start", async () => {
    f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Build our mobile app",
      title: "Mobile app",
    });
    const plan = runner.started[0] as TaskStartRequest;
    expect(await runner.mcp(plan.taskId, "complete_mission", { summary: "Too early" })).toMatchObject({
      ok: false,
      error: { code: "mission.not_started" },
    });
    await startMission(md(), f.owner.id, f.org.id, view.id);
    // The refused call above counted too: four more pass, the next is refused.
    for (let i = 0; i < 4; i++) ok(await runner.mcp(plan.taskId, "complete_mission", { summary: `Take ${i}` }));
    expect(await runner.mcp(plan.taskId, "complete_mission", { summary: "Again" })).toMatchObject({
      ok: false,
      error: { code: "mission.rate_limited" },
    });
  });
  test("agent mode: the agent's own complete_mission tool delivers (artifact ids from the Drive)", async () => {
    f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    // No coding CLI on the machine: the agent programs itself.
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Build the app",
      title: "Mobile app",
    });
    expect(view.executor).toBe("agent");
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev finish it",
      threadId: view.threadId,
    });
    await drainOutbox(f.db, f.handlers);
    const run = (await f.db.select().from(schema.agentRuns)).find((r) => r.triggerMessageId === msg.id);
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id as string,
      channelId: f.general.id,
      threadRootId: view.threadId,
      triggerMessageId: msg.id,
    };
    const call = async (name: string, input: Record<string, unknown>) => {
      const out = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
      if (out?.type !== "result") throw new Error(`expected a result, got ${out?.type}`);
      return out.output;
    };
    const names = (await f.tools?.list(ctx))?.map((t) => t.name) ?? [];
    expect(names).toContain("complete_mission");
    const plan = await call("update_plan", { items: [{ id: "a", title: "Telas via `upload_file`", status: "done" }] });
    expect(plan.isError).toBeFalsy();
    expect((await latestPlan(f.db, view.id))?.items[0]?.title).toBe("Telas");
    const out = await call("complete_mission", {
      summary: "Pronto: telas e login.",
      checklist: ["Abrir no celular"],
      artifact_ids: [crypto.randomUUID()],
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Delivered");
    expect(out.content).toContain("1 id(s) not found");
    expect((await missionRow()).status).toBe("awaiting_close");
    const [delivery] = await listDeliveries(md(), f.owner.id, f.org.id, view.id);
    expect(delivery).toMatchObject({
      auto: false,
      taskId: null,
      artifactIds: [],
      summary: "Pronto: telas e login.",
      checklist: [{ id: "c1", text: "Abrir no celular", checkedBy: [] }],
    });
  });
  test("owner and deciders hear command cards and deliveries (mission.needs_you), even outside the conversation", async () => {
    const { view, runner, main } = await started();
    const bia = await decider(view.id);
    const heard: Record<string, unknown>[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e) => heard.push(e as Record<string, unknown>));
    await setCommandApproval(md(), f.owner.id, f.org.id, view.id, "always");
    const asked = JSON.parse(
      ok(await runner.mcp(main.taskId, "permission_prompt", { tool_name: "Bash", input: { command: "swift build" } })),
    ) as { request_id: string };
    expect(heard).toContainEqual(
      expect.objectContaining({
        type: "mission.needs_you",
        kind: "command",
        missionId: view.id,
        promptId: asked.request_id,
      }),
    );
    const before = heard.length;
    await decideCommand(md(), f.owner.id, f.org.id, view.id, asked.request_id, "allow");
    expect(heard.length).toBe(before + 1);
    expect(heard.at(-1)).toMatchObject({ kind: "command", promptId: asked.request_id });
    ok(await runner.mcp(main.taskId, "complete_mission", { summary: "Done" }));
    expect(heard.at(-1)).toMatchObject({ type: "mission.needs_you", kind: "delivery", missionId: view.id });
  });
});
