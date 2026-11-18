import { afterEach, expect, test } from "bun:test";
import { CODEX_WINDOWS_PROTOCOL, orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  agentHoldsFor,
  createAgentRuns,
  endHold,
  insertMessage,
  KEEP_RUNNING_GUIDANCE,
  MAX_HOLDS_PER_AGENT,
  type MachineHub,
  stopAgentHold,
  type ToolContext,
  takeHold,
  updateSandboxSettings,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer, type FakeRunnerOptions, fakeRunner } from "./machine-fixtures";

/**
 * `keep_running` (ADR 0176): an agent keeps a program, its browser or a time running on its computer; people see
 * each hold on it and may stop it; the computer says when one ends, and what it holds when it says hello again.
 */

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function holdsSetup(options: FakeRunnerOptions = {}) {
  f = await setup({ machines: true });
  const { paired, runner } = await connectedComputer(f, { hello: SYSTEM, ...options });
  const run = async (): Promise<ToolContext> => {
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "deixa o bot rodando",
    });
    const [row] = await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "mention"));
    if (!row) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: row.id,
      channelId: f.general.id,
      threadRootId: row.threadRootId,
      triggerMessageId: row.triggerMessageId,
    };
  };
  const ctx = await run();
  const keep = async (input: Record<string, unknown>) => {
    const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "keep_running", input });
    if (r?.type !== "result") throw new Error(`not a result: ${JSON.stringify(r)}`);
    return r.output;
  };
  const asked = (op: string) =>
    runner.sent.filter((s) => s.type === "request" && s.op === op) as unknown as Record<string, unknown>[];
  const holds = () =>
    f.db.select().from(schema.machineHolds).where(eq(schema.machineHolds.machineId, paired.machineId));
  return { paired, runner, ctx, keep, asked, holds };
}

/** A system-mode computer's hello (believed from its first one, stored with what it found). */
const SYSTEM = { mode: "system", executors: {} };
const BOT = { what: "Telegram bot for the support group", why: "answers customers within a minute" };
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

test("a program's hold: the computer takes it for the agent, and people see it with Stop", async () => {
  const t = await holdsSetup();
  const out = await t.keep({ ...BOT, pid: 4242 });
  expect(out.isError).toBeFalsy();
  const [row] = await t.holds();
  expect(out.content).toBe(
    `Holding "${BOT.what}" (hold ${row?.id}) until it stops. People see it on your computer and can stop it.`,
  );
  const [start] = t.asked("keep.start");
  expect(start).toMatchObject({ op: "keep.start", holdId: row?.id, pid: 4242, agent: { id: f.agent.id } });
  // The words people read stay here: the computer gets only what binds the hold.
  expect(JSON.stringify(start)).not.toContain("Telegram");
  const seen = await agentHoldsFor({ db: f.db }, f.owner.id, f.org.id, f.agent.id);
  expect(seen).toEqual({
    holds: [
      {
        id: row?.id as string,
        agentId: f.agent.id,
        machineId: t.paired.machineId,
        what: BOT.what,
        why: BOT.why,
        kind: "program",
        since: row?.createdAt.toISOString() as string,
        until: null,
      },
    ],
    canStop: true,
  });
});

test("the same program again changes its hold; the agent's holds are capped; time alone needs an end within 7 days", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, pid: 4242 });
  const changed = await t.keep({ what: "Telegram bot", why: BOT.why, pid: 4242, until: inDays(2) });
  expect(changed.content).toStartWith('Changed "Telegram bot"');
  expect(await t.holds()).toHaveLength(1);
  expect(new Set(t.asked("keep.start").map((r) => r.holdId)).size).toBe(1);

  expect((await t.keep({ ...BOT })).isError).toBe(true);
  expect((await t.keep({ ...BOT, until: inDays(8) })).content).toContain("At most 7 days");
  expect((await t.keep({ ...BOT, until: "yesterday" })).isError).toBe(true);
  expect((await t.keep({ ...BOT, pid: 7, browser: true })).isError).toBe(true);
  for (let i = 1; i < MAX_HOLDS_PER_AGENT; i++) await t.keep({ ...BOT, pid: 5000 + i });
  const full = await t.keep({ ...BOT, until: inDays(1) });
  expect(full.isError).toBe(true);
  expect(full.content).toContain(`${MAX_HOLDS_PER_AGENT} things`);
});

test("a time's hold is kept longer by its id, its words kept; a browser's hold needs an end", async () => {
  const t = await holdsSetup();
  await t.keep({ what: "Weekend campaign", why: "posts on schedule", until: inDays(1) });
  const [row] = await t.holds();
  const later = inDays(6);
  const longer = await t.keep({ hold: row?.id, until: later });
  expect(longer.content).toStartWith('Changed "Weekend campaign"');
  const rows = await t.holds();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: row?.id, what: "Weekend campaign", why: "posts on schedule", endedAt: null });
  expect(rows[0]?.until?.toISOString()).toBe(later);
  expect(t.asked("keep.start").at(-1)).toMatchObject({ holdId: row?.id, until: later });
  expect(t.asked("keep.start").at(-1)).not.toHaveProperty("pid");

  expect((await t.keep({ hold: "0193f6b4-9999-7000-8000-000000000009", until: later })).isError).toBe(true);
  const starts = t.asked("keep.start").length;
  // A Chrome held with no end would never restart on a newer version.
  const open = await t.keep({ ...BOT, browser: true });
  expect(open).toMatchObject({ isError: true });
  expect(open.content).toContain("`until`");
  expect(t.asked("keep.start")).toHaveLength(starts);
});

test("a change the computer holds undoes an end heard meanwhile (its old lock's)", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, pid: 4242 });
  const [row] = await t.holds();
  if (!row) throw new Error("no hold");
  const out = await takeHold(
    {
      db: f.db,
      // The computer's `keep.ended` for the old lock lands before its answer to the change.
      call: async () => {
        await endHold({ db: f.db }, row, "exited");
        return { held: true } as never;
      },
    },
    {
      orgId: f.org.id,
      agent: { id: f.agent.id, handle: "agent" },
      machineId: t.paired.machineId,
      ...BOT,
      pid: 4242,
      until: new Date(inDays(1)),
    },
  );
  expect("row" in out && out.row).toMatchObject({ id: row.id, endedAt: null, endReason: null });
});

test("a person's Stop while the computer is away stops the program once it is back", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, pid: 4242 });
  await t.keep({ what: "Weekend campaign", why: "posts on schedule", until: inDays(1) });
  const all = await t.holds();
  const program = all.find((h) => h.pid !== null);
  const time = all.find((h) => h.pid === null);
  if (!program || !time) throw new Error("no holds");
  await t.runner.disconnect();
  const deps = { db: f.db, pubsub: f.pubsub, hub: f.machineHub as MachineHub };
  await stopAgentHold(deps, f.owner.id, f.org.id, f.agent.id, program.id);
  // Ended otherwise meanwhile (the agent's own end leaves its program running): only let go of.
  await endHold({ db: f.db }, time, "ended_by_agent");
  const again = fakeRunner(f.machineHub as MachineHub);
  await again.hello(t.paired.token, { ...SYSTEM, holds: { live: [program.id, time.id], ended: [] } });
  const ends = async () => {
    for (let i = 0; i < 100; i++) {
      const sent = again.sent.filter((s) => s.type === "request" && s.op === "keep.end");
      if (sent.length === 2) return sent;
      await Bun.sleep(10);
    }
    throw new Error("never told");
  };
  const sent = await ends();
  expect(sent.find((s) => (s as { holdId?: string }).holdId === program.id)).toMatchObject({ stop: true });
  expect(sent.find((s) => (s as { holdId?: string }).holdId === time.id)).not.toHaveProperty("stop");
});

test("the computer's refusal is the agent's answer, and nothing is shown to people", async () => {
  const t = await holdsSetup({
    keep: () => ({ fail: { code: "not_allowed", message: "Process 1 isn't one of your programs" } }),
  });
  const out = await t.keep({ ...BOT, pid: 1234 });
  expect(out).toMatchObject({ isError: true, content: "Not held: Process 1 isn't one of your programs." });
  expect(await t.holds()).toHaveLength(0);
});

test("the agent ends its hold; its next turns see it gone, with no arguments it lists what it keeps", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, browser: true, until: inDays(2) });
  await t.keep({ what: "Weekend campaign", why: "posts on schedule", until: inDays(3) });
  const listed = await t.keep({});
  expect(listed.content).toContain("Your holds now:");
  expect(listed.content).toContain(`"${BOT.what}": your browser`);
  const [browser] = (await t.holds()).filter((h) => h.browser);
  const ended = await t.keep({ end: browser?.id });
  expect(ended.content).toBe(`Ended hold ${browser?.id} ("${BOT.what}").`);
  expect(t.asked("keep.end").at(-1)).toMatchObject({ holdId: browser?.id });
  expect(t.asked("keep.end").at(-1)).not.toHaveProperty("stop");
  const [row] = (await t.holds()).filter((h) => h.id === browser?.id);
  expect(row?.endReason).toBe("ended_by_agent");
  expect((await t.keep({})).content).toContain("Ended lately:");
});

test("where every command asks a person first, taking a hold asks; listing and ending one need no why", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, pid: 4242 });
  const [row] = await t.holds();
  await updateSandboxSettings(f.db, f.owner.id, f.org.id, { requireApproval: true });
  const why = "answers the support group's customers within a minute, day and night";
  const asked = await f.tools?.invoke(t.ctx, {
    toolUseId: "tu_take",
    name: "keep_running",
    input: { what: "Weekend campaign", why, until: inDays(1) },
  });
  expect(asked?.type).toBe("approval");
  expect((await t.keep({})).content).toContain("Your holds now:");
  expect((await t.keep({ end: row?.id })).content).toBe(
    `Ended hold ${row?.id} ("${BOT.what}"). Its program runs on until you stop it.`,
  );
});

test("a person's Stop ends the program too; only who may use the computer, and admins, may", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, pid: 4242 });
  const [row] = await t.holds();
  const member = await addMember(f.db, f.org.id, "member", "bruno");
  expect((await agentHoldsFor({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).canStop).toBe(true);
  const deps = { db: f.db, pubsub: f.pubsub, hub: f.machineHub as MachineHub };
  await expect(stopAgentHold(deps, member.id, f.org.id, f.agent.id, row?.id as string)).rejects.toThrow();
  await stopAgentHold(deps, f.owner.id, f.org.id, f.agent.id, row?.id as string);
  expect(t.asked("keep.end").at(-1)).toMatchObject({ holdId: row?.id, stop: true });
  const [after] = await t.holds();
  expect(after).toMatchObject({ endReason: "stopped_by_person", endedByUserId: f.owner.id });
  expect((await agentHoldsFor({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).holds).toEqual([]);
});

test("a time's hold that ran out with no word from the computer ends at its time, audited, the apps told", async () => {
  const t = await holdsSetup();
  await t.keep({ what: "Weekend campaign", why: "posts on schedule", until: inDays(1) });
  const [row] = await t.holds();
  if (!row) throw new Error("no hold");
  const past = new Date(Date.now() - 60_000);
  await f.db.update(schema.machineHolds).set({ until: past }).where(eq(schema.machineHolds.id, row.id));
  const heard: unknown[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
    const event = (e as { event?: { type?: string } }).event;
    if (e.type === "org.broadcast" && event?.type === "machine.holds") heard.push(event);
  });
  const seen = await agentHoldsFor({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id);
  expect(seen.holds).toEqual([]);
  expect((await t.holds())[0]).toMatchObject({ endReason: "expired", endedAt: past });
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "machine.hold_ended"));
  expect(audit).toEqual([
    expect.objectContaining({
      actorType: "system",
      details: expect.objectContaining({ holdId: row.id, reason: "expired" }),
    }),
  ]);
  expect(heard).toEqual([{ type: "machine.holds", machineId: t.paired.machineId, agentId: f.agent.id }]);
});

test("the computer says one ended by itself, and on hello what it holds: a time's hold is taken again", async () => {
  const t = await holdsSetup();
  await t.keep({ ...BOT, pid: 4242 });
  await t.keep({ what: "Bot with no program", why: "kept a while", until: inDays(1) });
  await t.keep({ what: "The dashboard", why: "people watch it", browser: true, until: inDays(2) });
  const all = await t.holds();
  const program = all.find((h) => h.pid !== null);
  const time = all.find((h) => h.pid === null && !h.browser);
  const browser = all.find((h) => h.browser);
  await t.runner.frame({ type: "keep.ended", holdId: program?.id, reason: "exited" });
  expect((await t.holds()).find((h) => h.id === program?.id)?.endReason).toBe("exited");

  // The computer restarted: it holds nothing now, and holds one the server ended while it was away.
  const stale = "0193f6b4-9999-7000-8000-000000000009";
  const again = fakeRunner(f.machineHub as MachineHub);
  const startsBefore = t.asked("keep.start").length;
  await again.hello(t.paired.token, { ...SYSTEM, holds: { live: [stale], ended: [] } });
  const later = async () => {
    for (let i = 0; i < 100; i++) {
      const rows = await t.holds();
      if (rows.find((h) => h.id === browser?.id)?.endedAt) return rows;
      await Bun.sleep(10);
    }
    throw new Error("never reconciled");
  };
  const rows = await later();
  expect(rows.find((h) => h.id === browser?.id)?.endReason).toBe("restarted");
  expect(rows.find((h) => h.id === time?.id)?.endedAt).toBeNull();
  const retaken = again.sent.filter((s) => s.type === "request" && s.op === "keep.start");
  expect(retaken).toEqual([expect.objectContaining({ holdId: time?.id, until: time?.until?.toISOString() })]);
  expect(again.sent.filter((s) => s.type === "request" && s.op === "keep.end")).toEqual([
    expect.objectContaining({ holdId: stale }),
  ]);
  expect(t.asked("keep.start").length).toBe(startsBefore);
});

test("only on a Linux computer whose runner knows it, each agent its own user; its line says nothing of sleep", async () => {
  f = await setup({ machines: true });
  await connectedComputer(f, { protocol: CODEX_WINDOWS_PROTOCOL, hello: SYSTEM });
  const names = async () => {
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "oi",
    });
    const [row] = await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "mention"));
    const ctx = { db: f.db, orgId: f.org.id, agentId: f.agent.id, runId: row?.id, channelId: f.general.id };
    return ((await f.tools?.list(ctx as ToolContext)) ?? []).map((t) => t.name);
  };
  expect(await names()).not.toContain("keep_running");
  // Its agents share the runner's user there: every call would be refused.
  await connectedComputer(f, {}, "Laptop");
  expect(await names()).not.toContain("keep_running");
  await connectedComputer(f, { hello: SYSTEM }, "Server");
  expect(await names()).toContain("keep_running");
  expect(KEEP_RUNNING_GUIDANCE).not.toMatch(/sleep|paus|turn(s|ed)? off|awake/i);
});
