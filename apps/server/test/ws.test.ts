import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { authorizeSubscription, currentSubscriptions, parseClientFrame } from "../src/realtime/ws";
import { browser, createTestServer, joinByInvitation, listen, ORIGIN, seedOrg, signUp, type TestServer, upgradeStatus } from "./harness";

describe("parseClientFrame", () => {
  test("accepts subscribe/unsubscribe with a uuid and ping; rejects the rest", () => {
    const id = "0193a2b4-0000-7000-8000-000000000000";
    expect(parseClientFrame(JSON.stringify({ type: "subscribe", channelId: id }))).toEqual({
      type: "subscribe",
      channelId: id,
    });
    expect(parseClientFrame('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseClientFrame('{"type":"subscribe","channelId":"general"}')).toBeNull();
    expect(parseClientFrame("not json")).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "subscribe", channelId: id, pad: "x".repeat(5000) }))).toBeNull();
  });
});

let t: TestServer;
let server: ReturnType<typeof listen>;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["Hel", "lo ", "there"] }) });
  server = listen(t);
});
afterEach(async () => {
  // Bun 1.3 never resolves stop(true) after the server itself closed a socket
  // whose client lives in the same process; don't wait on it forever.
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
});

const wsUrl = (orgId: string) => `ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`;

/** Opens a socket and collects frames. Resolves once `ready` arrives, rejects if refused. */
function connect(url: string, headers: Record<string, string>) {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const waiters: { pred: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] =
    [];
  ws.onmessage = (e) => {
    const frame = JSON.parse(String(e.data)) as Record<string, unknown>;
    frames.push(frame);
    for (const w of [...waiters])
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
  };
  const next = (pred: (f: Record<string, unknown>) => boolean, ms = 5000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const found = frames.find(pred);
      if (found) return resolve(found);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(`timeout; frames: ${JSON.stringify(frames)}`)), ms);
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("refused"));
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
  });
  return { ws, frames, next, opened, send: (f: unknown) => ws.send(JSON.stringify(f)) };
}

test("upgrade requires a session, our Origin and org membership", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  expect(await upgradeStatus(wsUrl(orgId), { origin: ORIGIN })).toBe(401);
  expect(await upgradeStatus(wsUrl(orgId), { origin: "https://evil.example", cookie: owner.cookie() })).toBe(403);
  expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/api/ws`, { origin: ORIGIN, cookie: owner.cookie() })).toBe(
    400,
  );
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect(await upgradeStatus(wsUrl(orgId), { origin: ORIGIN, cookie: stranger.cookie() })).toBe(403);
});

test("revoked signed cookies cannot open a new realtime socket", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const oldCookies = owner.cookie();

  expect((await owner("/api/auth/sign-out", { json: {} })).status).toBe(200);
  expect(await upgradeStatus(wsUrl(orgId), { origin: ORIGIN, cookie: oldCookies })).toBe(401);
});

test("a revoked session closes its existing realtime socket", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const oldCookies = owner.cookie();
  const c = connect(wsUrl(orgId), { origin: ORIGIN, cookie: oldCookies });
  await c.opened;
  c.send({ type: "subscribe", channelId });
  await c.next((f) => f.type === "subscribed" && f.channelId === channelId);
  const closed = new Promise<number>((resolve) => c.ws.addEventListener("close", (e) => resolve(e.code)));

  expect((await owner("/api/auth/sign-out", { json: {} })).status).toBe(200);
  // The ordinary client pings; a revoked socket must close instead of
  // accepting another frame. The periodic check also bounds idle sockets.
  await Bun.sleep(2_100);
  c.send({ type: "ping" });
  expect(await Promise.race([closed, Bun.sleep(5_000).then(() => -1)])).toBe(4401);
});

test("subscriptions are limited to channels the person belongs to, in the connection's org", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const priv = (await (
    await owner(`/api/app/organizations/${orgId}/channels`, { json: { name: "secret", visibility: "private" } })
  ).json()) as { id: string };

  // Another person in the same org who is not in #secret.
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
  ).json()) as { url: string };
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  await ana(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  // And an outsider with an org of their own.
  const eve = browser(t);
  await signUp(eve, "eve@example.com");
  const eveOrg = (await (await eve("/api/app/organizations", { json: { name: "Eve Inc" } })).json()) as {
    organization: { id: string };
  };

  const a = connect(wsUrl(orgId), { origin: ORIGIN, cookie: ana.cookie() });
  await a.opened;
  await a.next((f) => f.type === "ready");
  a.send({ type: "subscribe", channelId });
  expect(await a.next((f) => f.channelId === channelId)).toEqual({ type: "subscribed", channelId });
  a.send({ type: "subscribe", channelId: priv.id });
  expect(await a.next((f) => f.channelId === priv.id)).toEqual({
    type: "error",
    code: "forbidden",
    channelId: priv.id,
  });
  a.ws.close();

  const e = connect(wsUrl(eveOrg.organization.id), { origin: ORIGIN, cookie: eve.cookie() });
  await e.opened;
  e.send({ type: "subscribe", channelId });
  expect(await e.next((f) => f.channelId === channelId)).toEqual({ type: "error", code: "not_found", channelId });
  e.ws.close();

  expect(await authorizeSubscription(t.db, (await meId(eve)) ?? "", orgId, channelId)).toBe("forbidden");
});

async function meId(b: ReturnType<typeof browser>) {
  return ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
}

test("end to end: a subscriber sees the message, the streamed deltas and the agent's reply", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const c = connect(wsUrl(orgId), { origin: ORIGIN, cookie: owner.cookie() });
  await c.opened;
  c.send({ type: "subscribe", channelId });
  await c.next((f) => f.type === "subscribed");

  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev hi" } });
  await t.drain();

  const done = await c.next((f) => f.type === "event" && (f.event as { type: string }).type === "message.handled");
  expect(done).toMatchObject({ channelId, event: { type: "message.handled", agentId, status: "done" } });
  const events = c.frames.filter((f) => f.type === "event").map((f) => f.event as Record<string, unknown>);
  expect(events.map((e) => e.type)).toEqual([
    "message.created",
    "message.routed",
    "agent.thinking",
    "agent.thinking",
    "message.claimed",
    "agent.run",
    "agent.typing",
    "agent.delta",
    "agent.delta",
    "agent.delta",
    "message.created",
    "agent.run",
    "agent.idle",
    "run.finished",
    "message.handled",
  ]);
  expect(
    events
      .filter((e) => e.type === "agent.delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Hello there");
  const reply = events[10] as {
    message: { body: string; threadId: string | null; author: { type: string; id: string } };
  };
  // Asked in the channel, answered in the channel.
  expect(reply.message).toMatchObject({
    body: "Hello there",
    threadId: null,
    author: { type: "agent", id: agentId },
  });
  expect(await t.adapters.presence.online(orgId)).toHaveLength(1);
  c.ws.close();
});

test("membership changes drop live subscriptions at once (channel, then organization)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
  ).json()) as { url: string };
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  await ana(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const anaId = (await meId(ana)) ?? "";
  const other = (await (
    await owner(`/api/app/organizations/${orgId}/channels`, { json: { name: "random" } })
  ).json()) as { id: string };
  await ana(`/api/app/organizations/${orgId}/channels/${other.id}/join`, { json: {} });

  const a = connect(wsUrl(orgId), { origin: ORIGIN, cookie: ana.cookie() });
  await a.opened;
  const closed = new Promise<number>((resolve) => a.ws.addEventListener("close", (e) => resolve(e.code)));
  a.send({ type: "subscribe", channelId });
  a.send({ type: "subscribe", channelId: other.id });
  await a.next((f) => f.type === "subscribed" && f.channelId === channelId);
  await a.next((f) => f.type === "subscribed" && f.channelId === other.id);

  // Removed from #general: that subscription ends now, and its events stop.
  const removed = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/members/people/${anaId}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(204);
  expect(await a.next((f) => f.type === "unsubscribed" && f.channelId === channelId)).toEqual({
    type: "unsubscribed",
    channelId,
    reason: "revoked",
  });
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "after removal" } });
  await owner(`/api/app/organizations/${orgId}/channels/${other.id}/messages`, { json: { body: "still here" } });
  const stillHere = await a.next((f) => f.type === "event" && f.channelId === other.id);
  expect(stillHere).toMatchObject({ event: { type: "message.created" } });
  expect(a.frames.some((f) => f.type === "event" && f.channelId === channelId)).toBe(false);

  // Removed from the organization: every subscription ends and the socket closes.
  expect((await owner(`/api/app/organizations/${orgId}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
  expect(await closed).toBe(4403);
  expect(a.frames).toContainEqual({ type: "unsubscribed", channelId: other.id, reason: "revoked" });
  expect(a.frames).toContainEqual({ type: "error", code: "membership_revoked" });
});

test("a missed revocation event is reconciled from durable membership", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const anaId = (await meId(ana)) ?? "";
  const publish = t.adapters.pubsub.publish.bind(t.adapters.pubsub);
  t.adapters.pubsub.publish = (topic, event) =>
    topic === orgTopic(orgId) && (event as { type?: string }).type === "membership.revoked"
      ? Promise.resolve()
      : publish(topic, event);

  const a = connect(wsUrl(orgId), { origin: ORIGIN, cookie: ana.cookie() });
  await a.opened;
  a.send({ type: "subscribe", channelId });
  await a.next((f) => f.type === "subscribed" && f.channelId === channelId);
  expect((await currentSubscriptions(t.db, anaId, orgId, [channelId]))?.has(channelId)).toBe(true);

  expect((await owner(`/api/app/organizations/${orgId}/channels/${channelId}/members/people/${anaId}`, {
    method: "DELETE",
  })).status).toBe(204);
  expect((await currentSubscriptions(t.db, anaId, orgId, [channelId]))?.has(channelId)).toBe(false);
  expect(await a.next((f) => f.type === "unsubscribed" && f.channelId === channelId, 20_000)).toMatchObject({
    reason: "revoked",
  });
  const closed = new Promise<number>((resolve) => a.ws.addEventListener("close", (e) => resolve(e.code)));
  expect((await owner(`/api/app/organizations/${orgId}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
  expect(await Promise.race([closed, Bun.sleep(20_000).then(() => -1)])).toBe(4403);
}, 60_000);
