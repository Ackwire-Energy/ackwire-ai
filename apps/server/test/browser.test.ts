import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { BROWSER_SCOPE, grantScopes, MachineRequestError } from "@agenteschat/engine";
import { createViewerPacer, parseBrowserClientFrame } from "../src/realtime/browser";
import { parseClientFrame } from "../src/realtime/ws";
import { browser, createTestServer, listen, ORIGIN, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

const AGENT = "0193a2b4-0000-7000-8000-000000000000";

describe("parseBrowserClientFrame: frame windows", () => {
  test("a watch says whether the client answers frames; an ack names the agent", () => {
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, acks: true }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
      acks: true,
    });
    // Only `true` asks for a window: an older client's watch gets frames as before.
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, acks: "yes" }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.ack", agentId: AGENT, seq: 4 }))).toEqual({
      type: "browser.ack",
      agentId: AGENT,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.ack", agentId: "dev" }))).toBeNull();
  });
});

describe("createViewerPacer", () => {
  type Message = { type: string; [key: string]: unknown };
  const frame = (seq: number): Message => ({ type: "browser.frame", agentId: AGENT, seq });
  const seqs = (got: Message[]) => got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []));

  test("at most the window's frames go undrawn; only the newest waits, and goes at the next ack", () => {
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 2 });
    for (const seq of [1, 2, 3, 4]) pacer.send(frame(seq));
    expect(seqs(got)).toEqual([1, 2]);
    // Other messages never wait behind frames.
    pacer.send({ type: "browser.status", agentId: AGENT, mode: "watch" });
    expect(got.at(-1)?.type).toBe("browser.status");
    pacer.ack();
    expect(seqs(got)).toEqual([1, 2, 4]);
    pacer.ack();
    pacer.ack();
    pacer.send(frame(5));
    expect(seqs(got)).toEqual([1, 2, 4, 5]);
    pacer.close();
  });

  test("a view that ends or hides drops the frame waiting; a closed pacer sends nothing", () => {
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 1 });
    pacer.send(frame(1));
    pacer.send(frame(2));
    pacer.send({ type: "browser.status", agentId: AGENT, hidden: true });
    pacer.ack();
    expect(seqs(got)).toEqual([1]);
    pacer.send(frame(3));
    pacer.send(frame(4));
    pacer.send({ type: "browser.ended", agentId: AGENT, reason: "stopped" });
    pacer.ack();
    expect(seqs(got)).toEqual([1, 3]);
    pacer.close();
    pacer.send(frame(5));
    pacer.send({ type: "browser.status", agentId: AGENT });
    expect(seqs(got)).toEqual([1, 3]);
    expect(got.at(-1)?.type).toBe("browser.ended");
  });

  test("a viewer that draws nothing for a while (a hidden tab) gets the newest frame anyway", async () => {
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 1, stallMs: 5 });
    for (const seq of [1, 2, 3]) pacer.send(frame(seq));
    expect(seqs(got)).toEqual([1]);
    await Bun.sleep(20);
    expect(seqs(got)).toEqual([1, 3]);
    pacer.close();
  });
});

describe("parseBrowserClientFrame", () => {
  test("watch, unwatch and input with checked events; the rest is not a browser frame", () => {
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
    });
    const input = parseBrowserClientFrame(
      JSON.stringify({
        type: "browser.input",
        agentId: AGENT,
        events: [
          { kind: "mouse", type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
          { kind: "text", text: "olá ção" },
        ],
      }),
    );
    expect(input).toMatchObject({
      type: "browser.input",
      events: [{ kind: "mouse" }, { kind: "text", text: "olá ção" }],
    });
    // When the person made a mouse event goes on to the computer (it keeps a drag's gaps); a time that isn't one doesn't.
    const timed = parseBrowserClientFrame(
      JSON.stringify({
        type: "browser.input",
        agentId: AGENT,
        events: [
          { kind: "mouse", type: "mouseMoved", x: 1, y: 2, button: "left", at: 1234.5 },
          { kind: "mouse", type: "mouseMoved", x: 1, y: 2, at: -1 },
        ],
      }),
    );
    expect(timed?.type === "browser.input" && timed.events).toEqual([
      { kind: "mouse", type: "mouseMoved", x: 1, y: 2, button: "left", at: 1234.5 },
      { kind: "mouse", type: "mouseMoved", x: 1, y: 2 },
    ]);
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.input", agentId: AGENT, events: [] }))).toBeNull();
    expect(
      parseBrowserClientFrame(JSON.stringify({ type: "browser.input", agentId: AGENT, events: [{ kind: "nope" }] })),
    ).toBeNull();
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: "dev" }))).toBeNull();
    expect(parseBrowserClientFrame(JSON.stringify({ type: "subscribe", channelId: AGENT }))).toBeNull();
    // A text paste larger than the 4 KB channel frames still parses as a browser frame.
    const big = JSON.stringify({
      type: "browser.input",
      agentId: AGENT,
      events: [{ kind: "text", text: "x".repeat(8000) }],
    });
    expect(parseClientFrame(big)).toBeNull();
    expect(parseBrowserClientFrame(big)).not.toBeNull();
  });
});

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const machine = await pairComputer(t, api, { os: "darwin", arch: "arm64", hostname: "mac", version: "0.3.0" });
  await t.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, org.agentId));
  return { owner, org, api, machine };
}

describe("handoff routes", () => {
  test("take over, read who is in control, hand back; outsiders get 403", async () => {
    const { org, api } = await seeded();
    expect(await (await api(`/agents/${org.agentId}/browser/handoff`)).json()).toEqual({ handoff: null });

    const takeover = await api(`/agents/${org.agentId}/browser/takeover`, { json: {} });
    expect(takeover.status).toBe(200);
    const h = (await takeover.json()) as { id: string; kind: string; status: string; controllerUserId: string };
    expect(h).toMatchObject({ kind: "takeover", status: "active" });
    const open = (await (await api(`/agents/${org.agentId}/browser/handoff`)).json()) as { handoff: { id: string } };
    expect(open.handoff.id).toBe(h.id);
    expect((await api(`/browser/handoffs/${h.id}`)).status).toBe(200);

    const other = browser(t);
    await signUp(other, "zed@example.com");
    const outsider = await other(`/api/app/organizations/${org.orgId}/browser/handoffs/${h.id}`);
    expect(outsider.status).toBe(403);

    const done = await api(`/browser/handoffs/${h.id}/done`, { json: {} });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe("done");
    expect((await api(`/browser/handoffs/${h.id}/done`, { json: {} })).status).toBe(409);
    expect(await (await api(`/agents/${org.agentId}/browser/handoff`)).json()).toEqual({ handoff: null });
  });

  test("the agent's browser settings and its open handoff are two routes, each with its own answer", async () => {
    const { org, api } = await seeded();
    const settings = (await (await api(`/agents/${org.agentId}/browser`)).json()) as Record<string, unknown>;
    expect(settings).toHaveProperty("allowedDomains");
    expect(settings).toHaveProperty("available");
    expect(settings).not.toHaveProperty("handoff");
    expect(await (await api(`/agents/${org.agentId}/browser/handoff`)).json()).toEqual({ handoff: null });
  });

  test("couldn't takes a note, and so does a hand back; cancel ends it", async () => {
    const { org, api } = await seeded();
    const takeover = async () =>
      (await (await api(`/agents/${org.agentId}/browser/takeover`, { json: {} })).json()) as { id: string };
    const first = await takeover();
    const failed = await api(`/browser/handoffs/${first.id}/failed`, { json: { note: "pediu o código da Ana" } });
    expect(await failed.json()).toMatchObject({ status: "failed", note: "pediu o código da Ana" });
    const second = await takeover();
    const canceled = await api(`/browser/handoffs/${second.id}/cancel`, { json: {} });
    expect(await canceled.json()).toMatchObject({ status: "cancelled" });
    const third = await takeover();
    const handedBack = await api(`/browser/handoffs/${third.id}/done`, {
      json: { note: "Entrei com a conta da loja" },
    });
    expect(await handedBack.json()).toMatchObject({ status: "done", note: "Entrei com a conta da loja" });
  });

  test("open a site: only the person in control; outside the agent's sites 403; a bad address 400", async () => {
    const { org, api } = await seeded();
    const path = `/api/app/organizations/${org.orgId}/agents/${org.agentId}/browser/open`;
    const json = { url: "https://shop.example.com" };
    expect((await browser(t)(path, { json })).status).toBe(401);
    const other = browser(t);
    await signUp(other, "zed@example.com");
    expect((await other(path, { json })).status).toBe(403);
    const notInControl = await api(`/agents/${org.agentId}/browser/open`, { json });
    expect(notInControl.status).toBe(409);
    expect(((await notInControl.json()) as { error: { code: string } }).error.code).toBe("browser.not_in_control");

    // The computer answers here: its browser is on, and it opens the page (starting the browser when closed) or refuses the site.
    const hub = t.engine.machineHub;
    const { call, status } = hub;
    const asked: MachineRequest[] = [];
    hub.status = (async (id: string) => ({
      id,
      orgId: org.orgId,
      name: "mac",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: 12,
      executors: { browser: { available: true, version: "0.39.1" } },
      paused: null,
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    })) as unknown as typeof hub.status;
    hub.call = (async (_machineId: string, request: MachineRequest) => {
      asked.push(request);
      if (request.op !== "browser.act") return { success: false, data: null };
      if (request.command !== "open") return { success: true, data: null };
      if (request.args[0]?.includes("evil")) {
        throw new MachineRequestError("not_allowed", "evil.example is outside the sites this agent may use");
      }
      return { success: true, data: { url: request.args[0] } };
    }) as typeof hub.call;
    try {
      await api(`/agents/${org.agentId}/browser/takeover`, { json: {} });
      // Not while the agent may not use its browser (`browser:use` taken away), as for its own tools.
      await t.db
        .delete(schema.agentScopes)
        .where(and(eq(schema.agentScopes.agentId, org.agentId), eq(schema.agentScopes.scope, BROWSER_SCOPE)));
      expect((await api(`/agents/${org.agentId}/browser/open`, { json })).status).toBe(403);
      expect(asked.some((r) => r.op === "browser.act" && r.command === "open")).toBe(false);
      await grantScopes(t.db, org.orgId, org.agentId, [{ connectionId: null, scope: BROWSER_SCOPE }]);
      expect(
        (await api(`/agents/${org.agentId}/browser/open`, { json: { url: "shop.example.com/login" } })).status,
      ).toBe(204);
      expect(asked.find((r) => r.op === "browser.act" && r.command === "open")).toMatchObject({
        args: ["https://shop.example.com/login"],
      });
      const refused = await api(`/agents/${org.agentId}/browser/open`, { json: { url: "https://evil.example" } });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("browser.not_allowed");
      const bad = await api(`/agents/${org.agentId}/browser/open`, { json: { url: "file:///etc/passwd" } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("browser.bad_address");
      // The address bar's arrows and reload: the browser's own commands, nothing else.
      for (const go of ["back", "forward", "reload"]) {
        expect((await api(`/agents/${org.agentId}/browser/open`, { json: { go } })).status).toBe(204);
        expect(asked.at(-1)).toMatchObject({ op: "browser.act", command: go, args: [] });
      }
      expect((await api(`/agents/${org.agentId}/browser/open`, { json: { go: "close" } })).status).toBe(400);
    } finally {
      hub.call = call;
      hub.status = status;
    }
  });

  test("stop: refused to outsiders; for the owner it reaches the computer (offline here)", async () => {
    const { org, api } = await seeded();
    const other = browser(t);
    await signUp(other, "zed@example.com");
    const outsider = await other(`/api/app/organizations/${org.orgId}/agents/${org.agentId}/browser/stop`, {
      json: {},
    });
    expect(outsider.status).toBe(403);
    // The computer isn't connected in this test: the owner's stop gets as far as the computer.
    const stop = await api(`/agents/${org.agentId}/browser/stop`, { json: {} });
    expect([204, 409, 503]).toContain(stop.status);
  });

  test("restart: only who may drive it; the browser closes, answers, and opens again on the page it showed", async () => {
    const { org, api } = await seeded();
    const path = `/api/app/organizations/${org.orgId}/agents/${org.agentId}/browser/restart`;
    expect((await browser(t)(path, { json: {} })).status).toBe(401);
    const other = browser(t);
    await signUp(other, "zed@example.com");
    expect((await other(path, { json: {} })).status).toBe(403);
    const hub = t.engine.machineHub;
    const { call } = hub;
    const asked: MachineRequest[] = [];
    hub.call = (async (_machineId: string, request: MachineRequest) => {
      asked.push(request);
      if (request.op !== "browser.act") return { stopped: true };
      return { success: true, data: request.command === "get" ? { url: "https://shop.example.com/cart" } : {} };
    }) as typeof hub.call;
    try {
      expect((await api(`/agents/${org.agentId}/browser/restart`, { json: {} })).status).toBe(204);
      // Opening again goes on after the answer.
      for (let i = 0; i < 50 && asked.length < 3; i++) await Bun.sleep(2);
      expect(asked.map((r) => (r.op === "browser.act" ? `act:${r.command}` : r.op))).toEqual([
        "act:get",
        "browser.stop",
        "act:open",
      ]);
      expect(asked.at(-1)).toMatchObject({ args: ["https://shop.example.com/cart"] });
    } finally {
      hub.call = call;
    }
  });
});

describe("live view socket", () => {
  test("watching an agent whose computer isn't connected here says so; another org's agent is refused", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    try {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${org.orgId}`, {
        headers: { cookie: owner.cookie(), origin: ORIGIN },
      } as unknown as string[]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("refused"));
      });
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
        return frames.find(pred);
      };
      await until((f) => f.type === "ready");
      // A watch that fails (a database hiccup) doesn't stick: the next one tries again.
      const live = t.engine.browserLive;
      const watch = live.watch;
      live.watch = async () => {
        throw new Error("database hiccup");
      };
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "unavailable",
      });
      live.watch = watch;
      frames.length = 0;
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "offline",
      });
      // Offline: the client's retry (watching again) is answered again, not ignored.
      frames.length = 0;
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "offline",
      });
      ws.send(JSON.stringify({ type: "browser.watch", agentId: AGENT }));
      expect(await until((f) => f.type === "error" && f.agentId === AGENT)).toMatchObject({ code: "not_found" });
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.code === "not_in_control")).toBeTruthy();
      ws.close();
    } finally {
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
  test("input frames enter the live view in the order they came, even when a later one's checks end first", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const live = t.engine.browserLive;
    const limiter = t.adapters.rateLimiter;
    const realConsume = limiter.consume;
    const realInput = live.input;
    try {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${org.orgId}`, {
        headers: { cookie: owner.cookie(), origin: ORIGIN },
      } as unknown as string[]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("refused"));
      });
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
        return frames.find(pred);
      };
      await until((f) => f.type === "ready");
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      await until((f) => f.type === "browser.unavailable");
      // The first frames' checks are the slowest: each later one would finish its await first.
      let n = 0;
      limiter.consume = async (key, rule) => {
        if (key.startsWith("ws-browser:")) await Bun.sleep(Math.max(0, 60 - 10 * n++));
        return realConsume(key, rule);
      };
      const typed: string[] = [];
      let answered = 0;
      live.input = async (_userId, _orgId, _agentId, events) => {
        for (const e of events) if (e.kind === "text") typed.push(e.text);
        // The computer's answer is slow too: it never holds back the frames behind it.
        await Bun.sleep(1000);
        answered++;
        return { accepted: events.length, refused: false };
      };
      const word = "abcdef";
      for (const ch of word) {
        ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: ch }] }));
      }
      for (let i = 0; i < 50 && typed.length < word.length; i++) await Bun.sleep(10);
      expect(typed.join("")).toBe(word);
      expect(answered).toBe(0);
      ws.close();
    } finally {
      limiter.consume = realConsume;
      live.input = realInput;
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
  test("an input frame whose checks fail (the rate limiter is away) answers unavailable instead of vanishing", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const limiter = t.adapters.rateLimiter;
    const realConsume = limiter.consume;
    try {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${org.orgId}`, {
        headers: { cookie: owner.cookie(), origin: ORIGIN },
      } as unknown as string[]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("refused"));
      });
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
        return frames.find(pred);
      };
      await until((f) => f.type === "ready");
      limiter.consume = async (key, rule) => {
        if (key.startsWith("ws-browser:")) throw new Error("limiter down");
        return realConsume(key, rule);
      };
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "unavailable",
      });
      ws.close();
    } finally {
      limiter.consume = realConsume;
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
});
