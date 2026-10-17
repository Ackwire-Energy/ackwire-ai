import { describe, expect, test } from "bun:test";
import { createExpoPushSender, createFakePushSender, EXPO_PUSH_URL, PushError, type PushMessage } from "../src";

const msg = (n: number): PushMessage => ({
  to: `ExponentPushToken[t${n}]`,
  title: "Oi",
  body: "Tudo certo?",
  data: { orgId: "o", kind: "mention", notificationId: `n${n}` },
});

const ticketFor = (to: string) => {
  if (to === "ExponentPushToken[t3]")
    return { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };
  if (to === "ExponentPushToken[t4]")
    return { status: "error", message: "too big", details: { error: "MessageTooBig" } };
  return { status: "ok", id: "x" };
};

describe("Expo push sender", () => {
  test("posts batches of at most 100 and maps tickets; DeviceNotRegistered marks the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createExpoPushSender({
      accessToken: "expo_test",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const batch = JSON.parse(String(init.body)) as { to: string }[];
        return Response.json({ data: batch.map((m) => ticketFor(m.to)) });
      }) as unknown as typeof fetch,
    });
    const messages = Array.from({ length: 150 }, (_, i) => msg(i));
    const results = await sender.send(messages);
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe(EXPO_PUSH_URL);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer expo_test");
    expect((JSON.parse(String(calls[0]?.init.body)) as unknown[]).length).toBe(100);
    expect((JSON.parse(String(calls[1]?.init.body)) as unknown[]).length).toBe(50);
    expect(JSON.parse(String(calls[0]?.init.body))[0]).toEqual({
      to: "ExponentPushToken[t0]",
      title: "Oi",
      body: "Tudo certo?",
      data: { orgId: "o", kind: "mention", notificationId: "n0" },
      sound: "default",
      priority: "default",
    });
    expect(results.length).toBe(150);
    expect(results[0]).toEqual({ token: "ExponentPushToken[t0]", ok: true, unregistered: false });
    expect(results[3]).toMatchObject({ ok: false, unregistered: true });
    expect(results[4]).toMatchObject({ ok: false, unregistered: false, error: "too big" });
  });

  test("no access token: no authorization header", async () => {
    let auth: string | null = "unset";
    const sender = createExpoPushSender({
      fetch: (async (_url: string, init: RequestInit) => {
        auth = new Headers(init.headers).get("authorization");
        return Response.json({ data: [{ status: "ok" }] });
      }) as unknown as typeof fetch,
    });
    await sender.send([msg(1)]);
    expect(auth).toBeNull();
  });

  test("429 and 5xx retry; other refusals don't", async () => {
    const failing = (status: number) => {
      const refuse = async () => Response.json({ errors: [{ code: "X", message: "nope" }] }, { status });
      return createExpoPushSender({ fetch: refuse as unknown as typeof fetch });
    };
    const retryable = async (status: number) => {
      try {
        await failing(status).send([msg(1)]);
        return "sent";
      } catch (error) {
        expect(error).toBeInstanceOf(PushError);
        return (error as PushError).retryable;
      }
    };
    expect(await retryable(429)).toBe(true);
    expect(await retryable(503)).toBe(true);
    expect(await retryable(400)).toBe(false);
  });
});

describe("fake push sender", () => {
  test("records messages and reports unregistered tokens", async () => {
    const fake = createFakePushSender({ unregistered: ["ExponentPushToken[t2]"] });
    const results = await fake.send([msg(1), msg(2)]);
    expect(fake.sent.map((m) => m.to)).toEqual(["ExponentPushToken[t1]"]);
    expect(results.map((r) => r.unregistered)).toEqual([false, true]);
  });
});
