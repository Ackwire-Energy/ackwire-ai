import { afterEach, expect, test } from "bun:test";
import type { ServerFrame } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { BROWSER_SCOPE, type BrowserLiveMessage, createBrowserLive, grantScopes, type MachineHub } from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
  f = undefined as never;
});

type Request = Extract<ServerFrame, { type: "request" }>;

/**
 * A runner over an in-memory socket that answers the live view's ops. `dead`: its socket's close never
 * arrives (a runner that restarted behind a proxy). `closedBrowser`: its agent's browser isn't open.
 */
function browserRunner(hub: MachineHub, opts: { dead?: boolean; closedBrowser?: boolean } = {}) {
  const got: Request[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      got.push(frame);
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "browser.stream.start") {
          if (!opts.closedBrowser) return ok({ mode: (frame as unknown as { mode: string }).mode });
          return void reply({
            type: "result",
            id: frame.id,
            ok: false,
            error: { code: "browser_closed", message: "The agent's browser isn't open" },
          });
        }
        if (frame.op === "browser.stream.stop") return ok({ stopped: true });
        if (frame.op === "browser.warm") return ok({ started: false });
        return ok({ success: true, data: { url: "https://facebook.com/login" } });
      }, 1);
    },
    close() {
      if (!opts.dead) void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  return {
    conn,
    starts: () => got.filter((r) => r.op === "browser.stream.start"),
    hello: (token: string) =>
      hub.message(
        conn,
        JSON.stringify({
          type: "hello",
          token,
          ...RUNNER,
          exec: true,
          browser: { available: true, version: "0.39.1" },
          access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
        }),
      ),
    frame: (seq: number) =>
      reply({
        type: "browser.frame",
        agentId: f.agent.id,
        seq,
        data: "/9j/AAAA",
        metadata: { deviceWidth: 1280, deviceHeight: 720 },
      }),
  };
}

async function liveSetup() {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "VPS" });
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, stopDelayMs: 1 });
  hub.setBrowserHooks(live.hubHooks);
  const got: BrowserLiveMessage[] = [];
  const viewer = { userId: f.owner.id, send: (m: BrowserLiveMessage) => got.push(m) };
  return { hub, paired, live, got, viewer };
}

const kinds = (got: BrowserLiveMessage[]) =>
  got.map((m) => (m.type === "browser.unavailable" ? `unavailable:${m.reason}` : m.type));

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(5);
};

test("a runner that restarts and says hello before its old socket's close is asked for the stream: the page comes back", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup();
  const old = browserRunner(hub, { dead: true });
  await old.hello(paired.token);
  await live.watch(viewer, f.org.id, f.agent.id);
  await old.frame(1);
  got.length = 0;
  // A machine update restarts the runner: the new one dials in while the old socket is still open here.
  const fresh = browserRunner(hub);
  await fresh.hello(paired.token);
  await until(() => kinds(got).includes("browser.status"));
  expect(fresh.starts()).toHaveLength(1);
  expect(kinds(got)).toEqual(["browser.status"]);
  await fresh.frame(2);
  expect(got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []))).toEqual([2]);
  live.close();
});

test("a runner that restarts after its socket closed: the views hear it reconnect, then its new runner is asked at once", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup();
  const old = browserRunner(hub);
  await old.hello(paired.token);
  await live.watch(viewer, f.org.id, f.agent.id);
  await old.frame(1);
  await hub.close(old.conn);
  expect(kinds(got).at(-1)).toBe("unavailable:reconnecting");
  // The new runner closed the agent's Chrome when it started: the views are told so, without waiting on a retry.
  const fresh = browserRunner(hub, { closedBrowser: true });
  await fresh.hello(paired.token);
  await until(() => kinds(got).includes("unavailable:closed"));
  expect(fresh.starts()).toHaveLength(1);
  expect(kinds(got).at(-1)).toBe("unavailable:closed");
  live.close();
});
