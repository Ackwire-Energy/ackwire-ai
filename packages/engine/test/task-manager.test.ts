import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addRunStep,
  cancelRun,
  computerQueue,
  drainOutbox,
  ForbiddenError,
  NotFoundError,
  listMessages,
  postPersonMessage,
  setStopReason,
  taskManager,
  taskSteps,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const runs = () => f.db.select().from(schema.agentRuns);
const stoppedNotices = async () =>
  (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).filter(
    (m) => (m.meta as { notice?: { kind?: string } }).notice?.kind === "run_stopped",
  );

describe("stopping a task tells the agent (ADR 0127)", () => {
  test("a notice in that conversation, with the reason, which wakes nothing; the next turn reads it", async () => {
    f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
    await ask("@dev prepara o relatório de vendas");
    const [run] = await runs();
    await cancelRun(deps(), f.owner.id, f.org.id, run?.id ?? "", { reason: "já fiz eu mesma" });

    const [notice] = await stoppedNotices();
    expect(notice?.meta).toMatchObject({
      notice: { kind: "run_stopped", refs: { runId: run?.id, byUserId: f.owner.id, reason: "já fiz eu mesma" } },
    });
    // Stopping means stop: the notice started no run.
    expect(await runs()).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);

    // The agent's next turn there reads it, as an event.
    await ask("@dev e agora, tudo certo?");
    await drainOutbox(f.db, f.handlers);
    const sent = JSON.stringify(f.provider.calls.at(-1)?.request.messages);
    expect(sent).toContain("A person stopped your task");
    expect(sent).toContain("já fiz eu mesma");
  });

  test("the reason said later: only who stopped it, once", async () => {
    f = await setup();
    await ask("@dev revisa o contrato");
    const [run] = await runs();
    await cancelRun(deps(), f.owner.id, f.org.id, run?.id ?? "");
    expect((await stoppedNotices())[0]?.meta).toMatchObject({ notice: { refs: { runId: run?.id } } });

    const other = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(setStopReason(deps(), other.id, f.org.id, run?.id ?? "", "não")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await setStopReason(deps(), f.owner.id, f.org.id, run?.id ?? "", "o cliente desistiu");
    const [notice] = await stoppedNotices();
    expect((notice?.meta as { notice: { text: string } }).notice.text).toContain("o cliente desistiu");
    await expect(setStopReason(deps(), f.owner.id, f.org.id, run?.id ?? "", "de novo")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("the task manager", () => {
  test("lists the tasks you see, what each uses now, and what ended", async () => {
    f = await setup();
    await ask("@dev compara os preços dos concorrentes");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    await addRunStep(f.db, run, "tool_call", { name: "browser_do", detail: "acme.example/precos" });

    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]).toMatchObject({
      runId: run.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      status: "queued",
      background: false,
      requester: { userId: f.owner.id },
      now: { tool: "browser_do", detail: "acme.example/precos" },
      steps: 1,
      canStop: true,
    });
    expect(view.tasks[0]?.label).toContain("compara os preços");
    expect(view.activity[f.agent.id]?.at(-1)).toBe(1);

    await cancelRun(deps(), f.owner.id, f.org.id, run.id);
    const after = await taskManager(f.db, f.owner.id, f.org.id);
    expect(after.tasks).toHaveLength(0);
    expect(after.ended[0]).toMatchObject({ runId: run.id, status: "canceled", stoppedBy: { userId: f.owner.id } });
  });

  test("a member who isn't in the conversation doesn't see its task", async () => {
    f = await setup();
    await ask("@dev arruma o link");
    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    const view = await taskManager(f.db, outsider.id, f.org.id);
    expect(view.tasks).toHaveLength(0);
  });

  test("a task's steps: what each call was, never its input; only for who sees the task", async () => {
    f = await setup();
    await ask("@dev manda o relatório pro cliente");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    await addRunStep(f.db, run, "tool_call", {
      toolUseId: "t1",
      name: "gmail_send_email",
      input: { to: "cliente@acme.example", body: "segredo" },
      connector: "Gmail",
      service: "gmail",
    });
    await addRunStep(f.db, run, "tool_result", {
      toolUseId: "t1",
      name: "gmail_send_email",
      isError: false,
      content: "sent",
    });

    const { steps } = await taskSteps(f.db, f.owner.id, f.org.id, run.id);
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result"]);
    expect(steps[0]?.data).toEqual({ toolUseId: "t1", name: "gmail_send_email", connector: "Gmail", service: "gmail" });
    expect(steps[1]?.data).toEqual({ toolUseId: "t1", name: "gmail_send_email", isError: false });

    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    await expect(taskSteps(f.db, outsider.id, f.org.id, run.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a task waiting for room on its computer is listed, and says so (not as waiting on a person)", async () => {
    f = await setup();
    await ask("@dev roda os testes");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        transcript: { waitingForBrain: { kind: "claude_code", code: "busy", waitId: "w1" } },
      })
      .where(eq(schema.agentRuns.id, run.id));
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.tasks[0]).toMatchObject({ runId: run.id, status: "waiting_input", held: "computer_busy" });
  });

  test("the computer's line: places (people first), the computers row, what each viewer may read", async () => {
    f = await setup();
    const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
    if (!machine) throw new Error("no machine");
    await ask("@dev roda os testes");
    await ask("@dev e o lint");
    const [a, b] = await runs();
    if (!a || !b) throw new Error("no runs");
    const inLine = (since: number, people: boolean) => ({
      status: "waiting_input" as const,
      waitingMachineId: machine.id,
      transcript: {
        waitingForBrain: { kind: "claude_code", code: "busy", waitId: "w" },
        roomWaitSince: since,
        roomPeople: people,
      },
    });
    // The agents' turn waited longer, but a person waits on the other one: it goes first.
    await f.db.update(schema.agentRuns).set(inLine(1_000, false)).where(eq(schema.agentRuns.id, a.id));
    await f.db.update(schema.agentRuns).set(inLine(2_000, true)).where(eq(schema.agentRuns.id, b.id));

    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.tasks.find((t) => t.runId === b.id)?.line).toMatchObject({
      machineId: machine.id,
      position: 1,
      of: 2,
      people: true,
    });
    expect(view.tasks.find((t) => t.runId === a.id)?.line).toMatchObject({ position: 2, of: 2, people: false });
    expect(view.computers).toEqual([{ id: machine.id, name: "Mac", working: 0, inLine: 2 }]);

    const queue = await computerQueue(f.db, f.owner.id, f.org.id, machine.id);
    expect(queue.line.map((t) => t.runId)).toEqual([b.id, a.id]);
    expect(queue.line[0]).toMatchObject({ kind: "person", visible: true, mine: true, canStop: true, people: true });
    expect(queue.line[0]?.label).toContain("o lint");

    // Someone outside the conversation sees the line, but not what it is about nor who asked.
    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    const theirs = await computerQueue(f.db, outsider.id, f.org.id, machine.id);
    expect(theirs.line).toHaveLength(2);
    expect(theirs.line[0]).toMatchObject({ kind: "person", who: null, label: null, visible: false, canStop: false });
  });
});
