import { afterEach, describe, expect, test } from "bun:test";
import { DESKTOP_PROTOCOL, type MachineRequest, STREAM_CLOSE, type StreamRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  authorizeStream,
  BROWSER_SCOPE,
  type BrowserLiveMessage,
  ConflictError,
  computerDrivers,
  createBrowserHandoffToolSource,
  createBrowserLive,
  createDesktopControl,
  createStreamBroker,
  DESKTOP_SCOPE,
  type DesktopControl,
  desktopStatus,
  drainOutbox,
  ForbiddenError,
  finishHandoff,
  grantScopes,
  type MachineCaller,
  type MachineHub,
  type MachineStatus,
  postPersonMessage,
  recheckStream,
  renderPush,
  requireComputerDriver,
  type StreamBroker,
  startDesktop,
  startTakeover,
  stopDesktop,
  waitIfPersonInControl,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { fakeSocket, until } from "./stream-fixtures";

let f: Fixture;
let broker: StreamBroker | undefined;
let control: DesktopControl | undefined;
afterEach(async () => {
  broker?.stop();
  control?.close();
  broker = undefined;
  control = undefined;
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WATCH: StreamRequest = { kind: "desktop", mode: "watch" };
const CONTROL: StreamRequest = { kind: "desktop", mode: "control" };
const TERMINAL: StreamRequest = { kind: "terminal", cols: 80, rows: 24 };
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ACCESS = {
  folders: [],
  tools: { claude: false, codex: false, commands: true, browser: true, desktop: true, terminal: true },
};

/** "sign in" makes the agent ask for help on its desktop. */
const reply = (req: ModelRequest) => {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  if (last.includes("sign in")) {
    return {
      chunks: [],
      toolUses: [{ name: "desktop_ask_person", input: { instructions: "Sign in to the bank app" } }],
    };
  }
  return { chunks: ["Feito."] };
};

/** The agent's computer as the tools see it: online, serving its browser and desktops. */
const toolHub: MachineCaller = {
  async status(id): Promise<MachineStatus | null> {
    return {
      id,
      orgId: f.org.id,
      name: "Box",
      online: true,
      execAllowed: true,
      os: "linux",
      protocol: DESKTOP_PROTOCOL,
      executors: { browser: { available: true }, desktop: { available: true }, terminal: { available: true } },
      paused: null,
      access: ACCESS,
    } as MachineStatus;
  },
  async call() {
    throw new Error("no runner for the tools in these tests");
  },
};

/**
 * The owner's agent on a Linux computer the owner paired, serving desktops (so its browser runs on its
 * desktop), with this server's stream broker and desktop control. The hub plays the runner: each
 * `stream.open` dials a data socket and says hello; `desktop.session.*` answers as a running desktop.
 */
async function start(options: { recheckMs?: number; agent?: boolean } = {}) {
  f = await setup({
    machines: true,
    reply,
    ...(options.agent ? { toolSources: [createBrowserHandoffToolSource({ machines: { hub: toolHub } })] } : {}),
  });
  const machine = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Box" });
  await f.db
    .update(schema.machines)
    .set({
      protocol: DESKTOP_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      access: ACCESS,
      executors: { browser: { available: true }, desktop: { available: true }, terminal: { available: true } },
    })
    .where(eq(schema.machines.id, machine.machineId));
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(
    f.db,
    f.org.id,
    f.agent.id,
    [BROWSER_SCOPE, DESKTOP_SCOPE].map((scope) => ({ connectionId: null, scope })),
  );
  const requests: MachineRequest[] = [];
  const hub = {
    isLocal: () => true,
    status: toolHub.status,
    async call(_machineId: string, request: MachineRequest) {
      requests.push(request);
      if (request.op === "desktop.session.status")
        return { running: true, startedAt: "2026-10-24T10:00:00Z", streams: 1 };
      if (request.op !== "stream.open") return {};
      const socket = fakeSocket();
      const link = created.accept(socket.socket);
      await created.fromRunner(
        link,
        JSON.stringify({ type: "stream.hello", token: machine.token, streamId: request.streamId }),
      );
      return { opened: true };
    },
  } as unknown as MachineHub;
  const created = createStreamBroker({
    db: f.db,
    hub,
    authorize: (input) => authorizeStream({ db: f.db, hub }, input),
    recheck: (stream) => recheckStream(f.db, stream),
    ...(options.recheckMs ? { limits: { accessRecheckMs: options.recheckMs } } : {}),
  });
  broker = created;
  control = createDesktopControl({ db: f.db, pubsub: f.pubsub, hub, streams: created });
  /** A person's viewer, once its stream is ready or refused. */
  const open = async (userId: string, request: StreamRequest) => {
    const viewer = fakeSocket();
    const stream = created.open(viewer.socket, { userId, orgId: f.org.id, agentId: f.agent.id, request });
    await until(() => stream.runner !== null || viewer.closed !== null, "the stream");
    return viewer;
  };
  const setMachine = (values: Partial<typeof schema.machines.$inferInsert>) =>
    f.db.update(schema.machines).set(values).where(eq(schema.machines.id, machine.machineId));
  const systemMode = () =>
    setMachine({
      executors: {
        browser: { available: true },
        desktop: { available: true },
        terminal: { available: true },
        mode: "system",
      },
    });
  return { machine, hub, requests, open, setMachine, systemMode };
}

/** A member of the workspace in #general who just asked the agent for work (its run is queued, live). */
async function asker(name: string, body = "@dev look at the dashboard") {
  const member = await addMember(f.db, f.org.id, "member", name);
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: member.id });
  const message = await postPersonMessage(deps(), member.id, f.org.id, f.general.id, { body });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  return { ...member, runId: run?.id as string };
}

describe("one person in control of the desktop", () => {
  test("taking over makes a desktop handoff: the others' views close (4409) and open again after the hand back", async () => {
    const { open, systemMode } = await start();
    // System mode: admins and the agent's owner drive its computer, so a second person could ask for control.
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const mine = await open(f.owner.id, WATCH);
    const hers = await open(bia.id, WATCH);
    expect([mine.closed, hers.closed]).toEqual([null, null]);

    const taken = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    expect(taken).toMatchObject({
      screen: "desktop",
      kind: "takeover",
      status: "active",
      controllerUserId: f.owner.id,
    });
    await until(() => hers.closed !== null, "the hidden view");
    expect(hers.closed?.code).toBe(STREAM_CLOSE.hidden);
    expect(mine.closed).toBeNull();
    // Nobody else sees it, or takes it, while she is in control; she drives it through a control stream.
    expect((await open(bia.id, WATCH)).closed?.code).toBe(STREAM_CLOSE.hidden);
    await expect(startTakeover(deps(), bia.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ConflictError,
    );
    const driving = await open(f.owner.id, CONTROL);
    expect(driving.closed).toBeNull();
    expect((await open(bia.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.hidden);

    // Handed back: control ends (4410, the panel opens a watcher again) and the others watch again.
    await finishHandoff(deps(), f.owner.id, f.org.id, taken.id, { result: "done", note: "signed in" });
    await until(() => driving.closed !== null, "the end of control");
    expect(driving.closed?.code).toBe(STREAM_CLOSE.controlEnded);
    expect((await open(bia.id, WATCH)).closed).toBeNull();
    expect((await open(f.owner.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.controlEnded);
  });

  test("a member behind the agent's work may watch; control is a shell: 403 on take over, 4403 on control", async () => {
    const { open, systemMode } = await start();
    const caio = await asker("caio");
    expect((await open(caio.id, WATCH)).closed).toBeNull();
    await expect(startTakeover(deps(), caio.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await open(caio.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect((await open(caio.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);

    // Every agent works as the runner's own user: only the person who paired the computer drives it, not an admin.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(requireComputerDriver(f.db, bia.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await open(bia.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    // Each agent its own user: admins and the agent's owner do; a member behind its work still doesn't.
    await systemMode();
    expect(await startTakeover(deps(), bia.id, f.org.id, f.agent.id, null, "desktop")).toMatchObject({
      controllerUserId: bia.id,
    });
    await expect(requireComputerDriver(f.db, caio.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("access is checked again while a stream is open; the controller's stream keeps their control alive", async () => {
    const { open } = await start({ recheckMs: 30 });
    const caio = await asker("caio");
    const watching = await open(caio.id, WATCH);
    expect(watching.closed).toBeNull();
    // Their run ended: they are no longer behind the agent's work.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, caio.runId));
    await until(() => watching.closed !== null, "the recheck");
    expect(watching.closed?.code).toBe(STREAM_CLOSE.forbidden);

    const taken = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    const driving = await open(f.owner.id, CONTROL);
    const handoff = schema.browserHandoffs;
    await f.db
      .update(handoff)
      .set({ expiresAt: new Date(Date.now() + 5_000) })
      .where(eq(handoff.id, taken.id));
    const deadline = async () =>
      (await f.db.select().from(handoff).where(eq(handoff.id, taken.id)))[0]?.expiresAt.getTime() ?? 0;
    await until(async () => (await deadline()) > Date.now() + 60_000, "the controller's presence");
    expect(driving.closed).toBeNull();
  });
});

describe("the browser and the desktop show one window", () => {
  test("a take over of either hides both views, blocks the other's take over, and the agent's tools wait", async () => {
    const { open } = await start();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const live = createBrowserLive({
      db: f.db,
      pubsub: f.pubsub,
      hub: { isLocal: () => true, call: async () => ({}) } as unknown as MachineHub,
    });
    const card: BrowserLiveMessage[] = [];
    const stopCard = await live.watch({ userId: bia.id, send: (m) => card.push(m) }, f.org.id, f.agent.id);
    const desktopView = await open(bia.id, WATCH);
    const message = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev check it" });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
    const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: run?.id as string };

    // The browser's take over (over the card) hides the desktop too.
    const browser = await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    expect(browser.screen).toBe("browser");
    await until(() => desktopView.closed !== null, "the hidden desktop");
    expect(desktopView.closed?.code).toBe(STREAM_CLOSE.hidden);
    await expect(startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop")).rejects.toMatchObject({
      code: "handoff.same_window",
    });
    expect((await waitIfPersonInControl(f.db, ctx, f.pubsub, "desktop"))?.data).toMatchObject({
      handoffId: browser.id,
    });
    await finishHandoff(live.handoffDeps, f.owner.id, f.org.id, browser.id, { result: "done" });

    // The desktop's take over hides the browser's card (CDP frames) the same way.
    const desktop = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    await until(
      () => card.some((m) => m.type === "browser.status" && m.hidden && m.handoff?.screen === "desktop"),
      "the hidden card",
    );
    await expect(startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id)).rejects.toMatchObject({
      code: "handoff.same_window",
    });
    expect((await waitIfPersonInControl(f.db, ctx, f.pubsub))?.data).toMatchObject({ handoffId: desktop.id });
    await finishHandoff(deps(), f.owner.id, f.org.id, desktop.id, { result: "done" });
    await until(() => card.at(-1)?.type === "browser.status" && !(card.at(-1) as { hidden: boolean }).hidden);
    stopCard();
    live.close();
  });

  test("a browser that doesn't run on the desktop (its switch off) keeps the two screens apart", async () => {
    const { setMachine } = await start();
    await setMachine({ access: { ...ACCESS, tools: { ...ACCESS.tools, desktop: false } } });
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: "none" };
    expect(await waitIfPersonInControl(f.db, ctx, f.pubsub, "desktop")).toBeNull();
  });
});

describe("the agent asks for help on its desktop", () => {
  test("desktop_ask_person goes only to who may drive the computer, with a push that says where it opens", async () => {
    await start({ agent: true });
    // The agent's owner is an admin who didn't pair the computer; Caio asks for the work.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    await asker("caio", "@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await f.db.select().from(schema.browserHandoffs);
    expect(h).toMatchObject({ screen: "desktop", kind: "ask", status: "pending", requestedForUserId: f.owner.id });
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, f.org.id), eq(schema.messages.id, h?.id as string)));
    expect(card?.meta).toMatchObject({ bodyCode: "desktop_handoff", browserHandoff: { screen: "desktop" } });
    const notified = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`));
    expect(notified.map((n) => n.userId)).toEqual([f.owner.id]);
    expect(notified[0]?.source).toMatchObject({ handoffId: h?.id, screen: "desktop" });
    expect(
      renderPush("pt-BR", { kind: "browser_handoff", waiting: true, actorName: "Dev", screen: "desktop" }),
    ).toEqual({
      title: "Dev precisa de você no computador",
      body: "Abra num computador para ver a tela.",
    });
  });

  test("who is asked: the owner when they may drive it, else everyone who may; nobody on a computer nobody paired", async () => {
    const { setMachine, systemMode } = await start();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([f.owner.id]);
    await systemMode();
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([bia.id]);
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
    expect((await computerDrivers(f.db, f.org.id, f.agent.id)).sort()).toEqual([f.owner.id, bia.id].sort());
    await setMachine({ pairedByUserId: null, executors: { desktop: { available: true } } });
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([]);
  });
});

describe("the desktop's REST and keep-alive", () => {
  test("its state for whoever may watch; on and off for admins, the agent's owner and who drives the computer", async () => {
    const { hub, requests, setMachine } = await start();
    const rest = { db: f.db, hub, streams: broker, pubsub: f.pubsub };
    const caio = await asker("caio");
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: true,
      running: true,
      startedAt: "2026-10-24T10:00:00Z",
      controllerUserId: null,
      canControl: true,
      canStart: true,
      terminal: { available: true, allowed: true },
    });
    expect(await desktopStatus(rest, caio.id, f.org.id, f.agent.id)).toMatchObject({
      canControl: false,
      canStart: false,
      terminal: { allowed: false },
    });
    await expect(startDesktop(rest, caio.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(stopDesktop(rest, caio.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await startDesktop(rest, bia.id, f.org.id, f.agent.id);
    await stopDesktop(rest, bia.id, f.org.id, f.agent.id);
    expect(requests.map((r) => r.op)).toEqual(
      expect.arrayContaining(["desktop.session.status", "desktop.session.start", "desktop.session.stop"]),
    );
    const outsider = await addMember(f.db, f.org.id, "member", "zed");
    await expect(desktopStatus(rest, outsider.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Switched off on the computer: not available, and why.
    await setMachine({ access: { ...ACCESS, tools: { ...ACCESS.tools, desktop: false } } });
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: false,
      reason: "not_allowed",
      running: false,
    });
  });

  test("an open desktop handoff keeps its desktop running", async () => {
    const { requests } = await start();
    expect(await control?.keepAlive()).toBe(0);
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    expect(await control?.keepAlive()).toBe(1);
    expect(requests.at(-1)).toMatchObject({ op: "desktop.session.start", agent: { id: f.agent.id, handle: "dev" } });
    expect(await control?.keepAlive()).toBe(0);
  });
});

test("system mode is believed from a computer's first hello, and only from one that has said so since", async () => {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const say = async (token: string, mode?: string) => {
    const conn = hub.open({ send() {}, close() {} });
    await hub.message(
      conn,
      JSON.stringify({
        type: "hello",
        token,
        version: "0.1.0",
        protocol: DESKTOP_PROTOCOL,
        os: "linux",
        arch: "x64",
        hostname: "box",
        workspace: "/srv/agents",
        exec: true,
        desktop: { available: true, width: 1280, height: 800 },
        terminal: { available: true },
        ...(mode ? { mode } : {}),
      }),
    );
    await hub.close(conn);
  };
  const modeOf = async (machineId: string) =>
    (await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId)))[0]?.executors?.mode ?? null;

  const system = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Server" });
  await say(system.token, "system");
  await say(system.token, "system");
  expect(await modeOf(system.machineId)).toBe("system");
  // Back to single-user: from then on a hello saying otherwise is the agents' own code talking.
  await say(system.token);
  await say(system.token, "system");
  expect(await modeOf(system.machineId)).toBeNull();

  const laptop = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Laptop" });
  await say(laptop.token);
  await say(laptop.token, "system");
  await say(laptop.token, "nonsense");
  expect(await modeOf(laptop.machineId)).toBeNull();
});
