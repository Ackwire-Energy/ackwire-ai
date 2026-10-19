import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { parseBrowserClientFrame } from "../src/realtime/browser";
import { parseClientFrame } from "../src/realtime/ws";
import { browser, createTestServer, listen, ORIGIN, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

const AGENT = "0193a2b4-0000-7000-8000-000000000000";

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

  test("couldn't takes a note; cancel ends it", async () => {
    const { org, api } = await seeded();
    const first = (await (await api(`/agents/${org.agentId}/browser/takeover`, { json: {} })).json()) as {
      id: string;
    };
    const failed = await api(`/browser/handoffs/${first.id}/failed`, { json: { note: "pediu o código da Ana" } });
    expect(await failed.json()).toMatchObject({ status: "failed", note: "pediu o código da Ana" });
    const second = (await (await api(`/agents/${org.agentId}/browser/takeover`, { json: {} })).json()) as {
      id: string;
    };
    const canceled = await api(`/browser/handoffs/${second.id}/cancel`, { json: {} });
    expect(await canceled.json()).toMatchObject({ status: "cancelled" });
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
      ws.send(JSON.stringify({ type: "browser.watch", agentId: AGENT }));
      expect(await until((f) => f.type === "error" && f.agentId === AGENT)).toMatchObject({ code: "not_found" });
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.code === "not_in_control")).toBeTruthy();
      ws.close();
    } finally {
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
});
