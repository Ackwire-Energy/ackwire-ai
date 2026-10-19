import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserInputEvent, MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  BROWSER_SCOPE,
  type BrowserLiveDeps,
  type BrowserLiveMessage,
  ConflictError,
  claimHandoff,
  createBrowserHandoffToolSource,
  createBrowserLive,
  drainOutbox,
  expireBrowserHandoffs,
  ForbiddenError,
  finishHandoff,
  grantScopes,
  listMessages,
  postPersonMessage,
  renderPush,
  startTakeover,
  type ToolSource,
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
        return (await waitIfPersonInControl(ctx.db, ctx)) ?? { content: "acted" };
      },
    },
  ],
};

async function start() {
  f = await setup({ reply, machines: true, toolSources: [createBrowserHandoffToolSource(), probe] });
  const pubsubDeps = { db: f.db, pubsub: f.pubsub };
  const machine = await pairMachine(pubsubDeps, f.owner.id, f.org.id, { name: "MacBook" });
  // Online as far as the tools can tell (no socket in these tests).
  await f.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machine.machineId));
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
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
    const ask = await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("waiting_input");
    const [h] = await handoffs();
    expect(h).toMatchObject({ kind: "ask", status: "pending", instructions: "Sign in to Stripe" });
    expect(h?.requestedForUserId).toBe(f.owner.id);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    const card = thread.find((m) => m.id === h?.id);
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
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
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
    // A member who isn't the agent's owner, an admin or in the conversation can't watch it.
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await f.db
      .delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, member.id)));
    await expect(claimHandoff(deps(), member.id, f.org.id, h?.id ?? "")).rejects.toBeTruthy();
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

  test("taking over while the agent asked claims that request instead of starting another", async () => {
    await start();
    await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    const claimed = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    expect(claimed.id).toBe(h?.id ?? "");
    expect(await handoffs()).toHaveLength(1);
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

  function fakeHub() {
    const calls: MachineRequest[] = [];
    const hub = {
      isLocal: () => true,
      call: async (_machineId: string, request: MachineRequest) => {
        calls.push(request);
        if (request.op === "browser.input") return { accepted: request.events.length };
        if (request.op === "browser.stream.start") return { mode: request.mode };
        return { stopped: true };
      },
    } as unknown as BrowserLiveDeps["hub"];
    return { hub, calls };
  }

  const viewer = (userId: string, busy = false) => {
    const got: BrowserLiveMessage[] = [];
    return { got, viewer: { userId, send: (m: BrowserLiveMessage) => got.push(m), busy: () => busy } };
  };

  test("frames fan out to the agent's viewers only; the stream follows who watches and who drives", async () => {
    const machine = await start();
    const { hub, calls } = fakeHub();
    const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, graceMs: 20 });
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
    expect(calls.at(-1)).toMatchObject({ op: "browser.stream.start", mode: "control" });
    expect(a.got.some((m) => m.type === "browser.status" && m.controllerUserId === f.owner.id)).toBe(true);
    expect(await live.input(f.owner.id, f.org.id, f.agent.id, events)).toEqual({ accepted: 1, refused: false });
    expect(await live.input("someone-else", f.org.id, f.agent.id, events)).toMatchObject({ refused: true });

    // The person in control leaves: back to watching, and control ends after the grace.
    stopA();
    await Bun.sleep(5);
    expect(calls.at(-1)).toMatchObject({ op: "browser.stream.start", mode: "watch" });
    await Bun.sleep(40);
    expect((await handoffs())[0]?.status).toBe("expired");

    stopB();
    stopSlow();
    await Bun.sleep(5);
    expect(calls.at(-1)).toMatchObject({ op: "browser.stream.stop" });
    expect(live.watching(f.agent.id)).toBe(false);
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
});
