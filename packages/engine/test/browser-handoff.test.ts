import { afterEach, describe, expect, test } from "bun:test";
import { type BrowserInputEvent, channelTopic, type MachineRequest, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  BROWSER_SCOPE,
  type BrowserLiveDeps,
  type BrowserLiveMessage,
  browserMachineOf,
  CONTROL_GRACE_MS,
  ConflictError,
  cancelHandoff,
  claimHandoff,
  coalesceInput,
  createBrowserHandoffToolSource,
  createBrowserLive,
  drainOutbox,
  expireBrowserHandoffs,
  expireControl,
  ForbiddenError,
  finishHandoff,
  grantScopes,
  handoffInfo,
  handoffResultText,
  listMessages,
  type MachineCaller,
  MachineRequestError,
  type MachineStatus,
  markPageRead,
  openPageInControl,
  postPersonMessage,
  renderPush,
  requireBrowserAccess,
  requireBrowserControl,
  requirePageRead,
  startTakeover,
  stopAgentBrowser,
  type ToolSource,
  touchControl,
  ValidationError,
  waitIfPersonInControl,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** "sign in" asks a person; "probe" acts in the browser (waits while a person is in control). */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  if (last.includes("sign in"))
    return { chunks: [], toolUses: [{ name: "browser_ask_person", input: { instructions: "Sign in to Stripe" } }] };
  if (last.includes("probe")) return { chunks: [], toolUses: [{ name: "browser_probe", input: {} }] };
  return { chunks: ["Feito."] };
};

/** Stands in for a browser tool: acts unless a person holds the browser. */
const probe: ToolSource = {
  name: "probe",
  tools: async () => [
    {
      name: "browser_probe",
      description: "test",
      scope: "",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        return (await waitIfPersonInControl(ctx.db, ctx, f.pubsub)) ?? { content: "acted" };
      },
    },
  ],
};

/** Computers whose browser is ready, as the browser tools see them (no runner socket in these tests). */
const ready = new Set<string>();
const readyHub: MachineCaller = {
  async status(id): Promise<MachineStatus | null> {
    if (!ready.has(id)) return null;
    return {
      id,
      orgId: f.org.id,
      name: "MacBook",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: 12,
      executors: { browser: { available: true, version: "0.39.1" } },
      paused: null,
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    } as MachineStatus;
  },
  async call() {
    throw new Error("no runner in these tests");
  },
};
const askSource = () => createBrowserHandoffToolSource({ machines: { hub: readyHub } });

async function start() {
  ready.clear();
  f = await setup({ reply, machines: true, toolSources: [askSource(), probe] });
  const pubsubDeps = { db: f.db, pubsub: f.pubsub };
  const machine = await pairMachine(pubsubDeps, f.owner.id, f.org.id, { name: "MacBook" });
  // Online as far as the tools can tell (no socket in these tests).
  await f.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machine.machineId));
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  ready.add(machine.machineId);
  return machine;
}

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const runs = () => f.db.select().from(schema.agentRuns);
const handoffs = () => f.db.select().from(schema.browserHandoffs);
const deps = () => ({ db: f.db, pubsub: f.pubsub });

describe("browser_ask_person", () => {
  test("asks with a card and a waiting notification; Done resumes the run, which checks the page", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("waiting_input");
    const [h] = await handoffs();
    expect(h).toMatchObject({ kind: "ask", status: "pending", instructions: "Sign in to Stripe" });
    expect(h?.requestedForUserId).toBe(f.owner.id);
    // Asked in the channel: the card is in the channel itself.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.id === h?.id);
    expect(card?.meta.bodyCode).toBe("browser_handoff");
    expect(card?.meta.browserHandoff).toMatchObject({ id: h?.id, status: "pending" });
    const [n] = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`));
    expect(n).toMatchObject({ userId: f.owner.id, kind: "browser_handoff", waiting: true });
    expect(n?.doneAt).toBeNull();

    const claimed = await claimHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "");
    expect(claimed).toMatchObject({ status: "active", controllerUserId: f.owner.id });
    const done = await finishHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "", { result: "done" });
    expect(done.status).toBe("done");
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person says it's done");
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.find((m) => m.id === h?.id)?.meta.browserHandoff).toMatchObject({ status: "done" });
    const [resolved] = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`));
    expect(resolved?.doneAt).not.toBeNull();
    await expect(finishHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "", { result: "done" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("Couldn't passes the person's note to the agent", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    await finishHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "", {
      result: "failed",
      note: "it asked for Ana's code",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await handoffs())[0]).toMatchObject({ status: "failed", note: "it asked for Ana's code" });
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("it asked for Ana's code");
  });

  test("a note on Pronto reaches the agent only: the card and the conversation's events carry Couldn't's alone", async () => {
    await start();
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(channelTopic(f.general.id), (e) => heard.push(e));
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    await finishHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "", {
      result: "done",
      note: "usei meu cartão, código 4821",
    });
    await drainOutbox(f.db, f.handlers);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("usei meu cartão, código 4821");
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.find((m) => m.id === h?.id)?.meta.browserHandoff).toMatchObject({ status: "done", note: null });
    const updates = heard.filter((e) => e.type === "browser.handoff.updated") as unknown as {
      handoff: { status: string; note: string | null };
    }[];
    expect(updates.at(-1)?.handoff).toMatchObject({ status: "done", note: null });
    // Ids are random hex and may hold those digits by chance: none of the note may be in what is left.
    const words = JSON.stringify(heard).replace(/[0-9a-f-]{8,}/g, "");
    expect(words).not.toContain("4821");
    expect(words).not.toContain("cartão");
  });

  test("past its deadline it expires and the run goes on", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    expect(await expireBrowserHandoffs(deps())).toBe(0);
    expect(await expireBrowserHandoffs(deps(), new Date(Date.now() + 31 * 60_000))).toBe(1);
    await drainOutbox(f.db, f.handlers);
    expect((await handoffs())[0]?.status).toBe("expired");
    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("No one did it in time");
  });

  test("one person in control at a time; outsiders can't take part", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    await claimHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "");
    await expect(claimHandoff(deps(), admin.id, f.org.id, h?.id ?? "")).rejects.toBeInstanceOf(ConflictError);
    await expect(finishHandoff(deps(), admin.id, f.org.id, h?.id ?? "", { result: "done" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const stranger = await addUser(f.db, "zed");
    await expect(claimHandoff(deps(), stranger.id, f.org.id, h?.id ?? "")).rejects.toBeInstanceOf(ForbiddenError);
    // Reading the channel isn't enough: the browser shows all of the agent's work.
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await expect(claimHandoff(deps(), member.id, f.org.id, h?.id ?? "")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireBrowserAccess(f.db, member.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelHandoff(deps(), member.id, f.org.id, h?.id ?? "")).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("both the person who asked and the agent's owner hear it; either can help, the first in control does", async () => {
    await start();
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: ana.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, ana.id, f.org.id, f.general.id, {
      body: "@dev sign in please",
    });
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    expect(h?.requestedForUserId).toBe(ana.id);
    const notified = await f.db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`));
    expect(notified.map((n) => n.userId).sort()).toEqual([ana.id, f.owner.id].sort());
    // Ana, who asked for the work, may take part; the owner gets there first.
    await requireBrowserAccess(f.db, ana.id, f.org.id, f.agent.id);
    await claimHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "");
    await expect(claimHandoff(deps(), ana.id, f.org.id, h?.id ?? "")).rejects.toBeInstanceOf(ConflictError);
    await expect(finishHandoff(deps(), ana.id, f.org.id, h?.id ?? "", { result: "done" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("pending it waits 10 min by default; in control there's no deadline, only the grace while they're away", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [pending] = await handoffs();
    const waited = (pending?.expiresAt.getTime() ?? 0) - (pending?.createdAt.getTime() ?? 0);
    expect(Math.round(waited / 60_000)).toBe(10);
    const claimed = await claimHandoff(deps(), f.owner.id, f.org.id, pending?.id ?? "");
    expect(claimed.expiresAt).toBeNull();
    // While they're there (watching or typing) the grace keeps moving; once away, it ends after the grace.
    const now = Date.now();
    await touchControl(f.db, claimed.id, f.owner.id, new Date(now + 90_000));
    expect((await handoffs())[0]?.expiresAt.getTime()).toBe(now + 90_000 + CONTROL_GRACE_MS);
    await touchControl(f.db, claimed.id, "someone-else", new Date(now + 10 * 60_000));
    expect((await handoffs())[0]?.expiresAt.getTime()).toBe(now + 90_000 + CONTROL_GRACE_MS);
    expect(await expireBrowserHandoffs(deps(), new Date(now + 60_000))).toBe(0);
    expect(await expireBrowserHandoffs(deps(), new Date(now + 90_000 + CONTROL_GRACE_MS + 1000))).toBe(1);
  });

  test("after a person had the browser, only browser_read works until the agent reads the page", async () => {
    await start();
    const ctx = { orgId: f.org.id, agentId: f.agent.id };
    expect(await requirePageRead(f.db, ctx)).toBeNull();
    const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    await finishHandoff(deps(), f.owner.id, f.org.id, t.id, { result: "done" });
    expect((await requirePageRead(f.db, ctx))?.content).toContain("Read the page again first");
    await markPageRead(f.db, ctx);
    expect(await requirePageRead(f.db, ctx)).toBeNull();
  });

  test("while a person is asked (pending), another run's browser call is refused", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const other = await waitIfPersonInControl(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: "00000000-0000-7000-8000-000000000000",
    });
    expect(other).toMatchObject({ isError: true });
    expect(other?.content).toContain("has been asked to take it");
  });

  test("a person's message woke the asking run and it ended: the next run's browser call waits on the open help", async () => {
    await start();
    const ask = await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    // No judge: the message only wakes the run; it answers and ends, the help stays open.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "which account?",
      threadId: ask.id,
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect((await handoffs())[0]?.status).toBe("pending");

    await post("@dev probe");
    await drainOutbox(f.db, f.handlers);
    const next = (await runs()).find((r) => r.id !== h?.runId);
    expect(next?.status).toBe("waiting_input");
    expect((await handoffs())[0]?.runId).toBe(next?.id);
    await finishHandoff(deps(), f.owner.id, f.org.id, h?.id ?? "", { result: "done" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).find((r) => r.id === next?.id)?.status).toBe("done");
  });

  test("a resume that fails doesn't strand the others, and the next sweep resumes it", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    // A second agent run also waiting on its own (already ended) handoff stands in for a resume that failed before.
    await f.db
      .update(schema.browserHandoffs)
      .set({ status: "done", resolvedAt: new Date() })
      .where(eq(schema.browserHandoffs.id, h?.id ?? ""));
    expect((await runs())[0]?.status).toBe("waiting_input");
    await expireBrowserHandoffs(deps());
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person says it's done");
  });

  test("the browser's computer: an open handoff's, else the one its tools last used, else the agent's", async () => {
    const own = await start();
    expect(await browserMachineOf(f.db, f.org.id, f.agent.id)).toBe(own.machineId);
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Mission box" });
    await f.db
      .update(schema.machines)
      .set({ online: true, lastSeenAt: new Date() })
      .where(eq(schema.machines.id, other.machineId));
    ready.add(other.machineId);
    // A run (it asked, and its request was dropped without waking it) in what becomes a mission's thread.
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [run] = await runs();
    const [first] = await handoffs();
    expect(first?.machineId).toBe(own.machineId);
    await f.db
      .update(schema.browserHandoffs)
      .set({ status: "cancelled", resolvedAt: new Date() })
      .where(eq(schema.browserHandoffs.id, first?.id ?? ""));
    await f.db.insert(schema.missions).values({
      orgId: f.org.id,
      threadRootId: run?.threadRootId ?? "",
      channelId: f.general.id,
      agentId: f.agent.id,
      machineId: other.machineId,
      title: "t",
      goal: "g",
      status: "active",
      mainSessionId: "s",
    });
    // Another run going on doesn't move it: the browser tools' last computer does.
    expect(await browserMachineOf(f.db, f.org.id, f.agent.id)).toBe(own.machineId);
    await f.db.update(schema.agents).set({ browserMachineId: other.machineId }).where(eq(schema.agents.id, f.agent.id));
    expect(await browserMachineOf(f.db, f.org.id, f.agent.id)).toBe(other.machineId);
    // Asking from the mission's thread uses the mission's computer, like the other browser tools.
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      threadRootId: run?.threadRootId ?? "",
    } as never;
    const [tool] = await askSource().tools(ctx);
    const out = await tool?.execute({ instructions: "Sign in again" }, ctx);
    expect(out?.isError).toBeUndefined();
    const second = (await handoffs()).find((h) => h.id !== first?.id);
    expect(second?.machineId).toBe(other.machineId);
    // An open handoff wins.
    await f.db.update(schema.agents).set({ browserMachineId: null }).where(eq(schema.agents.id, f.agent.id));
    expect(await browserMachineOf(f.db, f.org.id, f.agent.id)).toBe(other.machineId);
  });

  test("browser_ask_person is offered only when the agent's browser is ready", async () => {
    const machine = await start();
    const ctx = { db: f.db, orgId: f.org.id, agentId: f.agent.id, runId: "", threadRootId: null } as never;
    expect((await askSource().tools(ctx)).map((t) => t.name)).toEqual(["browser_ask_person"]);
    ready.delete(machine.machineId);
    expect(await askSource().tools(ctx)).toEqual([]);
    expect(await createBrowserHandoffToolSource().tools(ctx)).toEqual([]);
  });

  test("one open handoff per agent's browser, enforced by the database", async () => {
    const machine = await start();
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    const insertSecond = async () =>
      f.db.insert(schema.browserHandoffs).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId: machine.machineId,
        kind: "takeover",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      });
    await expect(insertSecond()).rejects.toThrow();
    // A second take over claims (here: already holds) the open one instead of starting another.
    const again = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    expect((await handoffs()).filter((h) => h.status === "pending" || h.status === "active")).toHaveLength(1);
    expect(again.controllerUserId).toBe(f.owner.id);
  });

  test("control only expires once its deadline in the database passed", async () => {
    await start();
    const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    // Still within the grace (they came back, or are typing on another server): nothing ends.
    expect(await expireControl(deps(), t.id, f.owner.id)).toBeNull();
    expect((await handoffs())[0]?.status).toBe("active");
    expect(await expireControl(deps(), t.id, f.owner.id, new Date(Date.now() + CONTROL_GRACE_MS + 1000))).toMatchObject(
      { status: "expired" },
    );
  });

  test("the push says the agent needs the person in the browser, with what it asked", () => {
    expect(
      renderPush("pt-BR", { kind: "browser_handoff", waiting: true, actorName: "Dev", text: "Entrar no Stripe" }),
    ).toEqual({
      title: "Dev precisa de você no navegador",
      body: "Entrar no Stripe",
    });
  });
});

describe("take over", () => {
  test("a person takes over: the agent's browser call waits until it is handed back", async () => {
    await start();
    const takeover = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    expect(takeover).toMatchObject({ kind: "takeover", status: "active", controllerUserId: f.owner.id });
    await post("@dev probe the page");
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("waiting_input");
    expect((await handoffs())[0]?.runId).toBe((await runs())[0]?.id ?? "");

    await finishHandoff(deps(), f.owner.id, f.org.id, takeover.id, { result: "done" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("handed it back");
  });

  test("Assumir from a run's card binds the take over to that run: its conversation hears it, the tray links there", async () => {
    await start();
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(channelTopic(f.general.id), (e) => heard.push(e));
    await post("@dev probe the page");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, run.id);
    expect(t).toMatchObject({ kind: "takeover", status: "active", runId: run.id });
    await Bun.sleep(5);
    const updates = heard.filter((e) => e.type === "browser.handoff.updated") as unknown as {
      threadId: string | null;
      handoff: { id: string; runId: string; kind: string };
    }[];
    expect(updates.some((e) => e.handoff.id === t.id && e.handoff.runId === run.id)).toBe(true);
    // Asked in the channel: the run's conversation is the channel itself.
    expect(updates[0]?.threadId).toBeNull();
    const [row] = await handoffs();
    if (!row) throw new Error("no handoff");
    expect((await handoffInfo(f.db, row))?.link).toBe(`/org/${f.org.id}/c/${f.general.id}`);

    // The run reaches its browser call and waits; handing back wakes it.
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("waiting_input");
    await finishHandoff(deps(), f.owner.id, f.org.id, t.id, { result: "done" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    // Over: it no longer shows on the run's conversation.
    expect(updates.at(-1)?.handoff).toMatchObject({ id: t.id });
    expect(
      (heard.filter((e) => e.type === "browser.handoff.updated").at(-1) as unknown as { handoff: { status: string } })
        .handoff.status,
    ).toBe("done");
  });

  test("a take over from the agent's or computer's page has no run: the tray opens the agent's browser on its page", async () => {
    await start();
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    const [row] = await handoffs();
    if (!row) throw new Error("no handoff");
    expect(row.runId).toBeNull();
    expect((await handoffInfo(f.db, row))?.link).toBe(`/org/${f.org.id}/agents/${f.agent.id}?computer=1`);
  });

  test("a run that isn't the agent's can't carry a take over; one that already ended binds nothing", async () => {
    await start();
    await expect(
      startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(ValidationError);
    await post("@dev hello");
    await drainOutbox(f.db, f.handlers);
    const [done] = await runs();
    expect(done?.status).toBe("done");
    const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, done?.id);
    expect(t.runId).toBeNull();
  });

  test("leaving without handing back is told as such, not as handed back", async () => {
    expect(handoffResultText({ result: "expired" }, "takeover")).toContain("left without handing it back");
    expect(handoffResultText({ result: "expired" }, "takeover")).not.toContain("handed it back.");
    expect(handoffResultText({ result: "done" }, "takeover")).toContain("handed it back");

    await start();
    await post("@dev probe the page");
    const [run] = await runs();
    const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, run?.id);
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("waiting_input");
    await expireControl(deps(), t.id, f.owner.id, new Date(Date.now() + CONTROL_GRACE_MS + 1000));
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("left without handing it back");
  });

  test("the hand back's facts: who, how long, the pages (titles quoted as the site's words) and the note as theirs", () => {
    expect(
      handoffResultText({ result: "done", note: "Entrei com a conta da loja" }, "takeover", {
        person: "Ana",
        forMs: 125_000,
        taken: { url: "https://shop.example.com/login", title: "Entrar" },
        returned: { url: "https://shop.example.com/orders" },
      }),
    ).toBe(
      "A person used your browser and handed it back. The page may have changed: read it again (browser_read) before acting.\n" +
        'Ana had control for 2 min. When they took it, the page was "Entrar" at https://shop.example.com/login. ' +
        "When they handed it back, it was https://shop.example.com/orders. " +
        'Their note, in their own words: "Entrei com a conta da loja"',
    );
    // A canceled request isn't the person's failure, and with nothing known nothing is added.
    expect(handoffResultText({ result: "cancelled" })).toBe(
      "A person canceled the request. Read the page again and decide what to do; if you are stuck, say what you need in your reply.",
    );
    // Who answered, when how long they had it isn't known (they answered from the card).
    expect(handoffResultText({ result: "failed" }, "ask", { person: "Ana", forMs: null })).toContain("\nAna answered.");
  });

  test("the run under a take over is canceled: the person keeps the browser, and the next run waits on it", async () => {
    await start();
    await post("@dev probe the page");
    const [first] = await runs();
    if (!first) throw new Error("no run");
    const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, first.id);
    await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, first.id));
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(channelTopic(f.general.id), (e) => heard.push(e));

    await post("@dev probe it again");
    await drainOutbox(f.db, f.handlers);
    const second = (await runs()).find((r) => r.id !== first.id);
    // Not refused as busy forever: the take over moved to the run that needs the browser now.
    expect(second?.status).toBe("waiting_input");
    const [row] = await handoffs();
    expect(row).toMatchObject({ id: t.id, status: "active", runId: second?.id ?? "", controllerUserId: f.owner.id });
    await Bun.sleep(5);
    expect(
      heard.some((e) => e.type === "browser.handoff.updated" && (e.handoff as { runId: string }).runId === second?.id),
    ).toBe(true);

    await finishHandoff(deps(), f.owner.id, f.org.id, t.id, { result: "done" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).find((r) => r.id === second?.id)?.status).toBe("done");
  });

  test("while the run under a take over still goes on, another run of the agent is refused", async () => {
    await start();
    await post("@dev probe the page");
    const [first] = await runs();
    if (!first) throw new Error("no run");
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, first.id);
    const other = { orgId: f.org.id, agentId: f.agent.id, runId: "00000000-0000-4000-8000-000000000001" };
    expect(await waitIfPersonInControl(f.db, other)).toMatchObject({ isError: true });
    expect((await handoffs())[0]?.runId).toBe(first.id);
  });

  test("taking over while the agent asked claims that request instead of starting another", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    const claimed = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    expect(claimed.id).toBe(h?.id ?? "");
    expect(await handoffs()).toHaveLength(1);
  });

  test("the person behind a live run only watches: taking over or opening a site is the owner's, an admin's or the asked person's", async () => {
    await start();
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: ana.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, ana.id, f.org.id, f.general.id, { body: "@dev hello" });
    await drainOutbox(f.db, f.handlers);
    // Her run still going on: she may watch the agent's browser (everyone's logins in it), not drive it.
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.agentId, f.agent.id));
    await requireBrowserAccess(f.db, ana.id, f.org.id, f.agent.id);
    await expect(requireBrowserControl(f.db, ana.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startTakeover(deps(), ana.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      openPageInControl(deps(), readyHub, ana.id, f.org.id, f.agent.id, "https://bank.example.com"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await handoffs()).toHaveLength(0);
    // The agent's owner and an admin may.
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    await requireBrowserControl(f.db, admin.id, f.org.id, f.agent.id);
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
  });

  test("the person a request was asked of takes control only while it is open", async () => {
    await start();
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: ana.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, ana.id, f.org.id, f.general.id, {
      body: "@dev sign in please",
    });
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    expect(h?.requestedForUserId).toBe(ana.id);
    await claimHandoff(deps(), ana.id, f.org.id, h?.id ?? "");
    await finishHandoff(deps(), ana.id, f.org.id, h?.id ?? "", { result: "done" });
    await drainOutbox(f.db, f.handlers);
    await expect(claimHandoff(deps(), ana.id, f.org.id, h?.id ?? "")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startTakeover(deps(), ana.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("live view", () => {
  const frame = (agentId: string, seq: number) => ({
    type: "browser.frame" as const,
    agentId,
    seq,
    data: "/9j/AAAA",
    metadata: { deviceWidth: 1280, deviceHeight: 720 },
  });

  /** The runner's side: `answer` may reply (or throw) first; otherwise every call works. */
  function fakeHub(answer: (request: MachineRequest) => unknown = () => undefined) {
    const calls: MachineRequest[] = [];
    const hub = {
      isLocal: () => true,
      status: (id: string) => readyHub.status(id),
      call: async (_machineId: string, request: MachineRequest) => {
        calls.push(request);
        const answered = answer(request);
        if (answered !== undefined) return answered;
        if (request.op === "browser.input") return { accepted: request.events.length };
        if (request.op === "browser.stream.start") return { mode: request.mode };
        return { stopped: true };
      },
    } as unknown as BrowserLiveDeps["hub"] & MachineCaller;
    return { hub, calls };
  }

  /** What the stream was asked (starts, mode changes, stops), without the reads of the page. */
  const streams = (calls: MachineRequest[]) => calls.filter((c) => c.op.startsWith("browser.stream"));

  const viewer = (userId: string, busy = false) => {
    const got: BrowserLiveMessage[] = [];
    return { got, viewer: { userId, send: (m: BrowserLiveMessage) => got.push(m), busy: () => busy } };
  };

  test("frames fan out to the agent's viewers only; the stream follows who watches and who drives", async () => {
    const machine = await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, graceMs: 20, stopDelayMs: 1 });
    const a = viewer(f.owner.id);
    const b = viewer("someone-else");
    const slow = viewer("slow", true);
    const stopA = await live.watch(a.viewer, f.org.id, f.agent.id);
    const stopB = await live.watch(b.viewer, f.org.id, f.agent.id);
    const stopSlow = await live.watch(slow.viewer, f.org.id, f.agent.id);
    expect(calls.filter((c) => c.op === "browser.stream.start")).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "browser.stream.start", mode: "watch", agent: { id: f.agent.id } });

    live.hubHooks.frame(machine.machineId, frame(f.agent.id, 1));
    live.hubHooks.frame("another-machine", frame(f.agent.id, 2));
    const frames = (got: BrowserLiveMessage[]) => got.filter((m) => m.type === "browser.frame");
    expect(frames(a.got)).toHaveLength(1);
    expect(frames(b.got)).toHaveLength(1);
    expect(frames(slow.got)).toHaveLength(0);

    // Input only from whoever is in control.
    const events: BrowserInputEvent[] = [{ kind: "text", text: "olá" }];
    expect(await live.input(f.owner.id, f.org.id, f.agent.id, events)).toEqual({ accepted: 0, refused: true });
    await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await Bun.sleep(5);
    expect(streams(calls).at(-1)).toMatchObject({ op: "browser.stream.start", mode: "control" });
    expect(a.got.some((m) => m.type === "browser.status" && m.controllerUserId === f.owner.id)).toBe(true);
    expect(await live.input(f.owner.id, f.org.id, f.agent.id, events)).toEqual({ accepted: 1, refused: false });
    expect(await live.input("someone-else", f.org.id, f.agent.id, events)).toMatchObject({ refused: true });

    // The person in control leaves: back to watching, and control ends after the grace.
    stopA();
    await Bun.sleep(5);
    expect(streams(calls).at(-1)).toMatchObject({ op: "browser.stream.start", mode: "watch" });
    await Bun.sleep(40);
    expect((await handoffs())[0]?.status).toBe("expired");

    stopB();
    stopSlow();
    await Bun.sleep(5);
    expect(streams(calls).at(-1)).toMatchObject({ op: "browser.stream.stop" });
    expect(live.watching(f.agent.id)).toBe(false);
  });

  test("Parar is heard by everyone watching: who stopped it, and when", async () => {
    await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const a = viewer(f.owner.id);
    const b = viewer("someone-else");
    await live.watch(a.viewer, f.org.id, f.agent.id);
    await live.watch(b.viewer, f.org.id, f.agent.id);
    await stopAgentBrowser(f.db, hub as unknown as MachineCaller, f.owner.id, f.org.id, f.agent.id, f.pubsub);
    await Bun.sleep(5);
    expect(calls.some((c) => c.op === "browser.stop")).toBe(true);
    for (const v of [a, b]) {
      const ended = v.got.find((m) => m.type === "browser.ended");
      expect(ended).toMatchObject({ type: "browser.ended", reason: "stopped", byUserId: f.owner.id });
      expect(typeof (ended as { at?: string }).at).toBe("string");
    }
    live.close();
  });

  test("the stream outlives its last viewer for a moment: a quick re-watch doesn't stop and start it", async () => {
    await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, stopDelayMs: 30 });
    const stop = await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    stop();
    await Bun.sleep(5);
    // Back before the stop: same stream, nothing asked of the computer.
    const stopAgain = await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    await Bun.sleep(50);
    expect(calls.map((c) => c.op)).toEqual(["browser.stream.start"]);
    // Gone for good: stopped once, after the delay.
    stopAgain();
    await Bun.sleep(5);
    expect(calls.some((c) => c.op === "browser.stream.stop")).toBe(false);
    await Bun.sleep(50);
    expect(calls.filter((c) => c.op === "browser.stream.stop")).toHaveLength(1);
    expect(live.watching(f.agent.id)).toBe(false);
    live.close();
  });

  test("a person's input goes in batches; plain mouse moves shrink to the last, drags stay whole", async () => {
    await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, inputBatchMs: 15 });
    await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await Bun.sleep(5);
    const move = (x: number, button?: "left"): BrowserInputEvent => ({
      kind: "mouse",
      type: "mouseMoved",
      x,
      y: 1,
      ...(button ? { button } : {}),
    });
    const sent = await Promise.all([
      live.input(f.owner.id, f.org.id, f.agent.id, [move(1)]),
      live.input(f.owner.id, f.org.id, f.agent.id, [move(2)]),
      live.input(f.owner.id, f.org.id, f.agent.id, [move(3)]),
      live.input(f.owner.id, f.org.id, f.agent.id, [
        { kind: "mouse", type: "mousePressed", x: 3, y: 1, button: "left" },
        move(4),
        move(5),
        { kind: "mouse", type: "mouseReleased", x: 5, y: 1, button: "left" },
      ]),
    ]);
    const inputs = calls.filter((c) => c.op === "browser.input");
    expect(inputs).toHaveLength(1);
    const events = (inputs[0] as Extract<MachineRequest, { op: "browser.input" }>).events as BrowserInputEvent[];
    expect(events.map((e) => (e.kind === "mouse" ? `${e.type}:${e.x}` : e.kind))).toEqual([
      "mouseMoved:3",
      "mousePressed:3",
      "mouseMoved:4",
      "mouseMoved:5",
      "mouseReleased:5",
    ]);
    expect(sent.every((r) => !r.refused)).toBe(true);
    live.close();
  });

  test("coalesceInput keeps keys, text and touches in order", () => {
    const events: BrowserInputEvent[] = [
      { kind: "mouse", type: "mouseMoved", x: 1, y: 1 },
      { kind: "key", type: "keyDown", key: "a" },
      { kind: "mouse", type: "mouseMoved", x: 2, y: 1 },
      { kind: "mouse", type: "mouseMoved", x: 3, y: 1 },
      { kind: "text", text: "olá" },
      { kind: "touch", type: "touchMove", touchPoints: [{ x: 1, y: 1 }] },
    ];
    expect(coalesceInput(events).map((e) => (e.kind === "mouse" ? `move:${e.x}` : e.kind))).toEqual([
      "move:1",
      "key",
      "move:3",
      "text",
      "touch",
    ]);
  });

  test("the person in control coming back within the grace keeps control", async () => {
    await start();
    const { hub } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, graceMs: 30 });
    const a = viewer(f.owner.id);
    const stop = await live.watch(a.viewer, f.org.id, f.agent.id);
    await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    stop();
    await Bun.sleep(5);
    await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    await Bun.sleep(50);
    expect((await handoffs())[0]).toMatchObject({ status: "active", controllerUserId: f.owner.id });
  });

  test("stream changes go one at a time: a controller joining during a start asks after it", async () => {
    await start();
    const calls: MachineRequest[] = [];
    let inFlight = 0;
    let overlapped = false;
    const hub = {
      isLocal: () => true,
      call: async (_m: string, request: MachineRequest) => {
        // A read of the page (who took control on which page) isn't a stream change.
        if (request.op === "browser.act") return { success: false, data: null };
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await Bun.sleep(10);
        calls.push(request);
        inFlight--;
        if (request.op === "browser.stream.start") return { mode: request.mode };
        return { stopped: true };
      },
    } as unknown as BrowserLiveDeps["hub"];
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await Promise.all([
      live.watch(viewer("watcher").viewer, f.org.id, f.agent.id),
      live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id),
    ]);
    await Bun.sleep(30);
    expect(overlapped).toBe(false);
    const starts = calls.filter((c) => c.op === "browser.stream.start");
    expect(starts.at(-1)).toMatchObject({ mode: "control" });
  });

  test("when control ends after the grace and nobody watches, the agent's live state is dropped", async () => {
    await start();
    const { hub } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, graceMs: 10 });
    const stop = await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await Bun.sleep(5);
    stop();
    await Bun.sleep(40);
    expect((await handoffs())[0]?.status).toBe("expired");
    // A fresh watch starts a new stream (the old state is gone).
    const { hub: hub2, calls } = fakeHub();
    void hub2;
    expect(live.watching(f.agent.id)).toBe(false);
    await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    expect(live.watching(f.agent.id)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a viewer who loses access is cut off; open handoffs keep the browser alive", async () => {
    await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, accessRecheckMs: 10 });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    const m = viewer(member.id);
    await live.watch(m.viewer, f.org.id, f.agent.id);
    await Bun.sleep(40);
    expect(m.got.some((x) => x.type === "browser.unavailable" && x.reason === "forbidden")).toBe(true);

    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const before = calls.length;
    expect(await live.keepAlive()).toBe(1);
    expect(calls.at(-1)).toMatchObject({ op: "browser.act", command: "get", args: ["url"] });
    expect(await live.keepAlive()).toBe(0);
    expect(calls.length).toBe(before + 1);
  });

  test("an agent without a computer, or one held by another server, says so", async () => {
    f = await setup({ reply });
    const { hub } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const a = viewer(f.owner.id);
    await live.watch(a.viewer, f.org.id, f.agent.id);
    expect(a.got[0]).toMatchObject({ type: "browser.unavailable", reason: "no_computer" });

    const machine = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Box" });
    await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
    const remote = createBrowserLive({
      db: f.db,
      pubsub: f.pubsub,
      hub: { ...hub, isLocal: () => false } as BrowserLiveDeps["hub"],
    });
    const b = viewer(f.owner.id);
    await remote.watch(b.viewer, f.org.id, f.agent.id);
    expect(b.got[0]).toMatchObject({ type: "browser.unavailable", reason: "offline" });
  });

  test("a handoff changed on another server reaches the live view here", async () => {
    await start();
    const { hub, calls } = fakeHub();
    const here = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const elsewhere = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub: { ...hub, isLocal: () => false } as never });
    const a = viewer(f.owner.id);
    await here.watch(a.viewer, f.org.id, f.agent.id);
    // The person takes over through the other server: this one (with the computer) switches to control.
    await startTakeover(elsewhere.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await Bun.sleep(20);
    expect(a.got.some((m) => m.type === "browser.status" && m.controllerUserId === f.owner.id)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ op: "browser.stream.start", mode: "control" });
    here.close();
    elsewhere.close();
  });

  test("when the browser moves to another computer, the old stream stops and its viewers reconnect", async () => {
    const own = await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const a = viewer(f.owner.id);
    await live.watch(a.viewer, f.org.id, f.agent.id);
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Mission box" });
    await f.db.update(schema.agents).set({ browserMachineId: other.machineId }).where(eq(schema.agents.id, f.agent.id));
    const b = viewer(f.owner.id);
    await live.watch(b.viewer, f.org.id, f.agent.id);
    await Bun.sleep(5);
    expect(a.got.some((m) => m.type === "browser.unavailable" && m.reason === "reconnecting")).toBe(true);
    expect(calls.some((c) => c.op === "browser.stream.stop")).toBe(true);
    // Frames from the old computer no longer reach anyone; the new one's do.
    live.hubHooks.frame(own.machineId, frame(f.agent.id, 1));
    live.hubHooks.frame(other.machineId, frame(f.agent.id, 2));
    expect(a.got.filter((m) => m.type === "browser.frame")).toHaveLength(0);
    expect(b.got.filter((m) => m.type === "browser.frame")).toHaveLength(1);
    live.close();
  });

  test("keep-alive pings only computers held by this server", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const { hub, calls } = fakeHub();
    const remote = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub: { ...hub, isLocal: () => false } as never });
    expect(await remote.keepAlive()).toBe(0);
    expect(calls).toHaveLength(0);
    remote.close();
  });

  const unavailable = (got: BrowserLiveMessage[]) => got.find((m) => m.type === "browser.unavailable");
  const lastStatus = (got: BrowserLiveMessage[]) => got.filter((m) => m.type === "browser.status").at(-1);
  const seqs = (got: BrowserLiveMessage[]) => got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []));

  test("a closed browser says closed (an older runner: unavailable); a site the person in control opens shows at once", async () => {
    await start();
    const older = fakeHub((r) => {
      if (r.op === "browser.stream.start")
        throw new MachineRequestError("bad_request", "The agent's browser isn't open");
    });
    const before = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub: older.hub });
    const o = viewer(f.owner.id);
    await before.watch(o.viewer, f.org.id, f.agent.id);
    expect(unavailable(o.got)).toMatchObject({ reason: "unavailable", message: "The agent's browser isn't open" });
    before.close();

    let open = false;
    const { hub, calls } = fakeHub((r) => {
      if (r.op === "browser.stream.start" && !open) {
        throw new MachineRequestError("browser_closed", "The agent's browser isn't open");
      }
      if (r.op === "browser.act" && r.command === "open") {
        open = true;
        return { success: true, data: { url: r.args[0] } };
      }
      return undefined;
    });
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const a = viewer(f.owner.id);
    await live.watch(a.viewer, f.org.id, f.agent.id);
    expect(unavailable(a.got)).toMatchObject({ reason: "closed" });

    // Taking over a closed browser, the person opens a site: the computer starts it, and the view starts with it.
    await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await openPageInControl(live.handoffDeps, hub, f.owner.id, f.org.id, f.agent.id, "shop.example.com/login");
    await Bun.sleep(20);
    expect(calls.find((c) => c.op === "browser.act" && c.command === "open")).toMatchObject({
      args: ["https://shop.example.com/login"],
      link: `/org/${f.org.id}/agents/${f.agent.id}?computer=1`,
    });
    expect(streams(calls).at(-1)).toMatchObject({ op: "browser.stream.start", mode: "control" });
    expect(lastStatus(a.got)).toMatchObject({ mode: "control", controllerUserId: f.owner.id, hidden: false });
    live.close();
  });

  test("only the person in control opens a site: web addresses only, and the agent's sites hold (the computer checks)", async () => {
    await start();
    const { hub, calls } = fakeHub((r) => {
      if (r.op !== "browser.act" || r.command !== "open") return undefined;
      if (r.args[0]?.includes("evil")) {
        throw new MachineRequestError("not_allowed", "evil.example is outside the sites this agent may use");
      }
      if (r.args[0]?.includes("nowhere")) return { success: false, data: null, error: "net::ERR_NAME_NOT_RESOLVED" };
      return { success: true, data: { url: r.args[0] } };
    });
    const open = (who: string, url: string) => openPageInControl(deps(), hub, who, f.org.id, f.agent.id, url);
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await expect(open(member.id, "https://shop.example.com")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(open(f.owner.id, "https://shop.example.com")).rejects.toMatchObject({
      code: "browser.not_in_control",
    });
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(open(admin.id, "https://shop.example.com")).rejects.toBeInstanceOf(ConflictError);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "  "]) {
      await expect(open(f.owner.id, bad)).rejects.toMatchObject({ code: "browser.bad_address" });
    }
    expect(calls).toHaveLength(0);

    await f.db
      .update(schema.agents)
      .set({ browserAllowedDomains: ["shop.example.com"] })
      .where(eq(schema.agents.id, f.agent.id));
    await open(f.owner.id, "shop.example.com/login");
    expect(calls.at(-1)).toMatchObject({
      op: "browser.act",
      command: "open",
      args: ["https://shop.example.com/login"],
      allowedDomains: ["shop.example.com"],
    });
    await expect(open(f.owner.id, "https://evil.example")).rejects.toMatchObject({ code: "browser.not_allowed" });
    await expect(open(f.owner.id, "https://nowhere.example")).rejects.toMatchObject({ code: "browser.open_failed" });
  });

  test("a site opens only while the agent may use its browser and its computer serves it, as for its own tools", async () => {
    const machine = await start();
    const { hub, calls } = fakeHub((r) =>
      r.op === "browser.act" && r.command === "open" ? { success: true, data: { url: r.args[0] } } : undefined,
    );
    const open = () => openPageInControl(deps(), hub, f.owner.id, f.org.id, f.agent.id, "shop.example.com");
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
    await expect(open()).rejects.toBeInstanceOf(ForbiddenError);
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
    ready.delete(machine.machineId);
    await expect(open()).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toHaveLength(0);
    ready.add(machine.machineId);
    await open();
    expect(calls.at(-1)).toMatchObject({ op: "browser.act", command: "open", args: ["https://shop.example.com/"] });
  });

  test("nobody takes over the browser of an agent that may not use it", async () => {
    await start();
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
    await expect(startTakeover(deps(), f.owner.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.db.select().from(schema.browserHandoffs)).toEqual([]);
  });

  test("input from the person in control hides the page from the others here, even when the change wasn't heard", async () => {
    const machine = await start();
    const { hub } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const a = viewer(f.owner.id);
    const b = viewer(admin.id);
    await live.watch(a.viewer, f.org.id, f.agent.id);
    await live.watch(b.viewer, f.org.id, f.agent.id);
    // Taken on another server whose word never came here (no live view, no pub/sub).
    await startTakeover({ db: f.db }, f.owner.id, f.org.id, f.agent.id);
    expect(lastStatus(b.got)).toMatchObject({ controllerUserId: null, hidden: false });

    expect(await live.sendInput(f.owner.id, f.org.id, f.agent.id, [{ kind: "text", text: "4821" }])).toMatchObject({
      refused: false,
    });
    expect(lastStatus(b.got)).toMatchObject({ controllerUserId: f.owner.id, hidden: true });
    live.hubHooks.frame(machine.machineId, frame(f.agent.id, 7));
    expect(seqs(b.got)).toEqual([]);
    expect(seqs(a.got)).toEqual([7]);
    live.close();
  });

  test("while a person is in control only they see the page; the others are told it's hidden, and see it again on hand back", async () => {
    const machine = await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const a = viewer(f.owner.id);
    const b = viewer(admin.id);
    await live.watch(a.viewer, f.org.id, f.agent.id);
    await live.watch(b.viewer, f.org.id, f.agent.id);
    live.hubHooks.frame(machine.machineId, frame(f.agent.id, 1));

    const t = await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    await Bun.sleep(5);
    expect(lastStatus(a.got)).toMatchObject({ controllerUserId: f.owner.id, hidden: false });
    expect(lastStatus(b.got)).toMatchObject({ controllerUserId: f.owner.id, hidden: true });
    expect(streams(calls).at(-1)).toMatchObject({ op: "browser.stream.start", mode: "control" });
    live.hubHooks.frame(machine.machineId, frame(f.agent.id, 2));
    expect(seqs(a.got)).toEqual([1, 2]);
    expect(seqs(b.got)).toEqual([1]);
    // Joining meanwhile: told who has it, nothing of the page.
    const c = viewer(admin.id);
    await live.watch(c.viewer, f.org.id, f.agent.id);
    expect(lastStatus(c.got)).toMatchObject({ hidden: true });
    expect(seqs(c.got)).toEqual([]);

    // Handed back: the others get the page as it is now, without waiting for it to repaint.
    await finishHandoff(live.handoffDeps, f.owner.id, f.org.id, t.id, { result: "done" });
    await Bun.sleep(5);
    expect(lastStatus(b.got)).toMatchObject({ controllerUserId: null, hidden: false });
    expect(seqs(b.got)).toEqual([1, 2]);
    expect(seqs(c.got)).toEqual([2]);
    expect(seqs(a.got)).toEqual([1, 2]);
    // So does anyone who joins a stream already running.
    const d = viewer(f.owner.id);
    await live.watch(d.viewer, f.org.id, f.agent.id);
    expect(seqs(d.got)).toEqual([2]);
    live.close();
  });

  test("handing back tells the agent who had it, for how long, the pages and their note, in their own words", async () => {
    const machine = await start();
    const { hub } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub });
    await live.watch(viewer(f.owner.id).viewer, f.org.id, f.agent.id);
    const on = (seq: number, url: string, title: string) => ({
      ...frame(f.agent.id, seq),
      metadata: { deviceWidth: 1280, deviceHeight: 720, url, title },
    });
    live.hubHooks.frame(machine.machineId, on(1, "https://shop.example.com/login", "Entrar"));
    await post("@dev probe the page");
    const [run] = await runs();
    const t = await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id, run?.id);
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("waiting_input");
    live.hubHooks.frame(machine.machineId, on(2, "https://shop.example.com/orders", "Pedidos"));
    await finishHandoff(live.handoffDeps, f.owner.id, f.org.id, t.id, {
      result: "done",
      note: "Entrei com a conta da loja",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    const told = lastText(f.provider.calls.at(-1)?.request as ModelRequest);
    for (const fact of [
      "handed it back",
      "ana had control for",
      "Entrar",
      "https://shop.example.com/login",
      "Pedidos",
      "https://shop.example.com/orders",
      "Their note, in their own words",
      "Entrei com a conta da loja",
    ]) {
      expect(told).toContain(fact);
    }
    // Its next action on the page waits for a fresh read, saying the same.
    const ctx = { orgId: f.org.id, agentId: f.agent.id };
    const stale = await requirePageRead(f.db, ctx);
    expect(stale?.content).toContain("Read the page again first");
    expect(stale?.content).toContain("Entrei com a conta da loja");
    expect(stale?.content).toContain("https://shop.example.com/orders");
    await markPageRead(f.db, ctx);
    expect(await requirePageRead(f.db, ctx)).toBeNull();
    live.close();
  });
});
