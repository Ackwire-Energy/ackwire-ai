import { describe, expect, test } from "bun:test";
import { readDeleteResponse } from "../src/features/account/result";
import { chooseOrg } from "../src/lib/org-choice";
import { photoSource } from "../src/lib/photo";
import { deviceBody, devicePath, quietWhileOpen, readPushData } from "../src/lib/push-payload";
import { createSocketFactory } from "../src/lib/socket";
import { authErrorKey, isEmail } from "../src/lib/validate";
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

test("sign-in helpers", () => {
  expect(isEmail("ana@empresa.com")).toBe(true);
  expect(isEmail("ana@empresa")).toBe(false);
  expect(authErrorKey({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }, "signIn")).toBe("mobile.auth.signIn.wrong");
  expect(authErrorKey({ status: 422, code: "USER_ALREADY_EXISTS" }, "signUp")).toBe("mobile.auth.signUp.taken");
  expect(authErrorKey(null, "signIn")).toBe("mobile.auth.errors.generic");
});

test("every icon of the prototype is there", () => {
  const required =
    "home chat agent bell search plus send back more check x clock shield hash chev right image file camera mic target list reply copy pin eyeoff moon sun globe out code server mail chart pen doc sparkle smile laptop archive circle pause flag".split(
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
