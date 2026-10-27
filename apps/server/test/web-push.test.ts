import { afterEach, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeWebPushSender, generateVapidKeys } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createApp } from "../src/app";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * Browser push (ADR 0071): the server's Web Push key, registering a browser's subscription, and a
 * mention reaching it through the outbox.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123:APA91bTest";

/** A browser's subscription, as `PushSubscription.toJSON()` gives it. */
function subscription(endpoint = ENDPOINT) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    platform: "web",
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") },
    locale: "pt-BR",
  };
}

describe("web push key", () => {
  test("the same public key on every call, for signed-in people only", async () => {
    t = await createTestServer();
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const first = await owner("/api/app/push/web");
    expect(first.status).toBe(200);
    const { publicKey } = (await first.json()) as { publicKey: string };
    expect(Buffer.from(publicKey, "base64url").length).toBe(65);
    expect(((await (await owner("/api/app/push/web")).json()) as { publicKey: string }).publicKey).toBe(publicKey);
    const [row] = await t.db.select().from(schema.instancePush);
    expect(row?.vapidPublicKey).toBe(publicKey);
    // Sealed, never the key itself.
    expect(row?.vapidPrivateKey).not.toContain(publicKey);
    expect(JSON.parse(row?.vapidPrivateKey ?? "{}")).toHaveProperty("ciphertext");
    expect((await browser(t)("/api/app/push/web")).status).toBe(401);
  });

  test("pinned keys win and aren't stored", async () => {
    const pair = generateVapidKeys();
    t = await createTestServer({
      env: { WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey },
    });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    expect(await (await owner("/api/app/push/web")).json()).toEqual({ publicKey: pair.publicKey });
    expect(await t.db.select().from(schema.instancePush)).toEqual([]);
  });

  test("404 web_push_off when this server sends no browser push", async () => {
    t = await createTestServer({ webPush: null });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const res = await owner("/api/app/push/web");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("web_push_off");
  });
});

describe("web push devices", () => {
  test("register a browser (https endpoint, real keys), refresh it, remove it by its encoded endpoint", async () => {
    t = await createTestServer();
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const register = (body: unknown) => owner("/api/app/push/devices", { json: body });
    const sub = subscription();

    expect((await register({ ...sub, endpoint: "http://push.example/x" })).status).toBe(400);
    expect((await register({ ...sub, endpoint: "not a url" })).status).toBe(400);
    expect((await register({ ...sub, keys: { ...sub.keys, p256dh: "A".repeat(87) } })).status).toBe(400);
    expect((await register({ ...sub, keys: { ...sub.keys, auth: "short" } })).status).toBe(400);
    expect((await register({ ...sub, keys: undefined })).status).toBe(400);
    expect((await register({ ...sub, endpoint: `https://push.example/${"x".repeat(2100)}` })).status).toBe(400);
    // A phone token with the web platform, or a web subscription with a phone platform: neither shape.
    expect((await register({ ...sub, platform: "ios" })).status).toBe(400);

    expect((await register(sub)).status).toBe(204);
    // Padding some browsers add is dropped.
    const padded = { ...sub, keys: { ...sub.keys, auth: `${sub.keys.auth}==` }, locale: "en" };
    expect((await register(padded)).status).toBe(204);
    const rows = await t.db.select().from(schema.pushDevices);
    expect(rows.map((r) => [r.token, r.platform, r.locale, r.webKeys])).toEqual([
      [ENDPOINT, "web", "en", { p256dh: sub.keys.p256dh, auth: sub.keys.auth }],
    ]);

    const path = `/api/app/push/devices/${encodeURIComponent(ENDPOINT)}`;
    expect((await owner(path, { method: "DELETE" })).status).toBe(204);
    expect(await t.db.select().from(schema.pushDevices)).toEqual([]);
  });

  test("a mention reaches the browser through the outbox, with the page to open", async () => {
    const webPush = createFakeWebPushSender();
    t = await createTestServer({ webPush });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId, channelId } = await seedOrg(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    expect((await bia("/api/app/push/devices", { json: subscription() })).status).toBe(204);
    const members = (await (await owner(`/api/app/organizations/${orgId}/members`)).json()) as {
      members: { email: string; handle: string }[];
    };
    const handle = members.members.find((m) => m.email === "bia@example.com")?.handle;
    await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
      json: { body: `@${handle} pode olhar?` },
    });
    await t.drain();
    expect(webPush.sent).toHaveLength(1);
    const mentions = await t.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "mention"));
    const notification = mentions[0];
    expect(webPush.sent[0]).toMatchObject({
      endpoint: ENDPOINT,
      urgency: "normal",
      payload: {
        title: "owner mencionou você",
        body: `@${handle} pode olhar?`,
        tag: notification?.id,
        url: `/org/${orgId}/notifications`,
        data: { orgId, kind: "mention", channelId, notificationId: notification?.id },
      },
    });
    // The phone sender got nothing: no phone registered.
    expect(t.push.sent).toHaveLength(0);
  });
});

describe("the service worker", () => {
  test("/sw.js: JavaScript, always revalidated; a plain 404 (never the web app) when the build has none", async () => {
    const web = mkdtempSync(join(tmpdir(), "agentes-sw-"));
    try {
      writeFileSync(join(web, "index.html"), '<!doctype html><div id="root"></div>');
      const app = () =>
        createApp({ edition: "selfhost", version: "1", modules: [], pingDatabase: async () => {}, webDir: web });
      const missing = await app().request("/sw.js");
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain("root");

      writeFileSync(join(web, "sw.js"), "self.addEventListener('push', () => {});");
      const res = await app().request("/sw.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/javascript");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("addEventListener('push'");
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});
