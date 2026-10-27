import { describe, expect, test } from "bun:test";
import { readDeleteResponse } from "../src/features/account/result";
import { chooseOrg, firstRunMounted, serverDownOf } from "../src/lib/org-choice";
import { photoSource } from "../src/lib/photo";
import { createHolder, deviceBody, devicePath, quietWhileOpen, readPushData } from "../src/lib/push-payload";
import { connectPlan, currentServer, savedServer } from "../src/lib/server-choice";
import { createSocketFactory } from "../src/lib/socket";
import { ICON_NAMES } from "../src/ui/icons.data";

describe("push payload", () => {
  test("keeps only known string fields", () => {
    expect(
      readPushData({ orgId: "o1", kind: "approval", approvalId: "a1", extra: "x", channelId: 5, threadId: "" }),
    ).toEqual({ orgId: "o1", kind: "approval", approvalId: "a1" });
    expect(readPushData(null)).toEqual({});
    expect(readPushData("nope")).toEqual({});
  });
  test("device registration body and path", () => {
    expect(deviceBody("ExponentPushToken[abc]", "ios", "pt-BR")).toEqual({
      token: "ExponentPushToken[abc]",
      platform: "ios",
      locale: "pt-BR",
    });
    expect(deviceBody("t", "android", "en").platform).toBe("android");
    expect(devicePath("ExponentPushToken[a b]")).toBe("/api/app/push/devices/ExponentPushToken%5Ba%20b%5D");
  });
  test("a push about the conversation on screen stays quiet", () => {
    const open = { orgId: "o1", channelId: "c1" };
    expect(quietWhileOpen({ orgId: "o1", channelId: "c1", kind: "message" }, open)).toBe(true);
    expect(quietWhileOpen({ channelId: "c1" }, open)).toBe(true);
    expect(quietWhileOpen({ orgId: "o1", channelId: "c2" }, open)).toBe(false);
    expect(quietWhileOpen({ orgId: "o2", channelId: "c1" }, open)).toBe(false);
    expect(quietWhileOpen({ orgId: "o1", kind: "approval" }, open)).toBe(false);
    expect(quietWhileOpen({ orgId: "o1", channelId: "c1" }, null)).toBe(false);
  });

  test("the conversation on screen: a blur after the next screen took over doesn't clear it", () => {
    const open = createHolder<{ orgId: string; channelId: string }>();
    const releaseA = open.hold({ orgId: "o1", channelId: "c1" });
    // The thread of the same channel focuses first, then the channel blurs.
    const releaseB = open.hold({ orgId: "o1", channelId: "c1" });
    releaseA();
    expect(open.get()).toEqual({ orgId: "o1", channelId: "c1" });
    releaseB();
    expect(open.get()).toBeNull();
  });
});

describe("account deletion", () => {
  const res = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  test("204 is done", async () => {
    expect(await readDeleteResponse(res(204, undefined))).toEqual({ ok: true });
  });
  test("409 sole_owner lists the organizations", async () => {
    expect(
      await readDeleteResponse(res(409, { error: { code: "sole_owner", params: { organizations: ["Acme", 3] } } })),
    ).toEqual({ ok: false, reason: "sole_owner", organizations: ["Acme"] });
  });
  test("anything else failed", async () => {
    expect(await readDeleteResponse(res(500, "oops"))).toEqual({ ok: false, reason: "failed", status: 500 });
  });
});

test("the WebSocket carries the cookie and the app header", () => {
  const made: { url: string; protocols: unknown; options: unknown }[] = [];
  class FakeSocket {
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    constructor(url: string, protocols?: unknown, options?: unknown) {
      made.push({ url, protocols, options });
    }
    send() {}
    close() {}
  }
  const factory = createSocketFactory(() => "better-auth.session_token=abc", FakeSocket);
  factory("wss://agentes.chat/api/ws?orgId=o1");
  expect(made[0]).toEqual({
    url: "wss://agentes.chat/api/ws?orgId=o1",
    protocols: undefined,
    options: { headers: { "X-Agentes-Client": "mobile", Cookie: "better-auth.session_token=abc" } },
  });
  createSocketFactory(() => "", FakeSocket)("wss://x");
  expect(made[1]?.options).toEqual({ headers: { "X-Agentes-Client": "mobile" } });
});

test("organization choice: remembered if still a member, else the first", () => {
  const orgs = [{ id: "a" }, { id: "b" }];
  expect(chooseOrg(orgs, "b")).toBe("b");
  expect(chooseOrg(orgs, "gone")).toBe("a");
  expect(chooseOrg([], "a")).toBeNull();
});

test("the first run: kept, hidden, under an invitation's screen once mounted; never first mounted under one", () => {
  // An invitation opened from the first run: its answers and its workspace stay.
  expect(firstRunMounted(true, true, true)).toBe(true);
  // An invitation opened first: the first run waits for it to close, then mounts.
  expect(firstRunMounted(false, true, true)).toBe(false);
  expect(firstRunMounted(false, true, false)).toBe(true);
  // A workspace now (joined, or made): gone, and not kept for the next invitation.
  expect(firstRunMounted(true, false, false)).toBe(false);
  expect(firstRunMounted(false, false, true)).toBe(false);
});

test("a server that can't be opened gets its own screen, never the first run", () => {
  // The account failed with nothing cached: down, with the server's own reason once its check says one.
  expect(serverDownOf(true, false, null)).toBe("unreachable");
  expect(serverDownOf(true, false, { ok: false, problem: "certificate" })).toBe("certificate");
  // The server answers but the account didn't load: still can't open it.
  expect(serverDownOf(true, false, { ok: true })).toBe("unreachable");
  // Slow: only once the server is known to be out of reach.
  expect(serverDownOf(false, true, null)).toBeNull();
  expect(serverDownOf(false, true, { ok: true })).toBeNull();
  expect(serverDownOf(false, true, { ok: false, problem: "unreachable" })).toBe("unreachable");
  // Loaded: an old failed check doesn't matter.
  expect(serverDownOf(false, false, { ok: false, problem: "unreachable" })).toBeNull();
});

test("every icon of the design is there", () => {
  const required =
    "home chat agent bell search plus send back more check x clock shield wait hash chev right image file camera mic target list reply copy pin eyeoff moon sun globe out code server mail chart pen doc sparkle smile laptop archive circle pause flag info".split(
      " ",
    );
  for (const name of required) expect(ICON_NAMES).toContain(name as (typeof ICON_NAMES)[number]);
});

describe("person photo", () => {
  const base = "https://agentes.chat";
  const headers = { "X-Agentes-Client": "mobile", Cookie: "s=1" };
  test("a photo uploaded here loads from the API with the session", () => {
    expect(photoSource("/api/app/avatars/u1/a.png", base, headers)).toEqual({
      uri: "https://agentes.chat/api/app/avatars/u1/a.png",
      headers,
    });
    expect(photoSource("https://agentes.chat/api/app/avatars/u1/a.png", base, headers)?.headers).toEqual(headers);
  });
  test("a provider's photo loads without our cookie", () => {
    expect(photoSource("https://lh3.googleusercontent.com/a/x", base, headers)).toEqual({
      uri: "https://lh3.googleusercontent.com/a/x",
    });
  });
  test("nothing usable keeps the initial", () => {
    expect(photoSource(null, base, headers)).toBeNull();
    expect(photoSource("  ", base, headers)).toBeNull();
    expect(photoSource("//evil.example/x.png", base, headers)).toBeNull();
    expect(photoSource("javascript:alert(1)", base, headers)).toBeNull();
  });
});

describe("choosing a server", () => {
  const cloud = "https://agentes.chat";
  const box = "https://box.tail1234.ts.net";

  test("the one chosen, else the build's; nothing kept for the build's own", () => {
    expect(currentServer(null, cloud)).toBe(cloud);
    expect(currentServer(box, cloud)).toBe(box);
    expect(currentServer("not a server", cloud)).toBe(cloud);
    expect(savedServer(box, cloud)).toBe(box);
    expect(savedServer(cloud, cloud)).toBeNull();
  });

  test("another server is left first: signing out, or only forgetting the cookie when nobody is in", () => {
    expect(connectPlan(cloud, true, { server: box })).toEqual({
      move: true,
      signOut: true,
      forget: false,
      token: null,
    });
    expect(connectPlan(cloud, false, { server: box })).toEqual({
      move: true,
      signOut: false,
      forget: true,
      token: null,
    });
    expect(connectPlan(cloud, false, { server: box, token: "t" })).toEqual({
      move: true,
      signOut: false,
      forget: true,
      token: "t",
    });
    expect(connectPlan(cloud, true, { server: box, token: "t" })).toEqual({
      move: true,
      signOut: true,
      forget: false,
      token: "t",
    });
  });

  test("a token on the same server replaces whoever is in", () => {
    expect(connectPlan(box, true, { server: box, token: "t" })).toEqual({
      move: false,
      signOut: true,
      forget: false,
      token: "t",
    });
    expect(connectPlan(box, false, { server: box, token: "t" })).toEqual({
      move: false,
      signOut: false,
      forget: false,
      token: "t",
    });
    expect(connectPlan(box, true, { server: box })).toEqual({
      move: false,
      signOut: false,
      forget: false,
      token: null,
    });
  });
});
