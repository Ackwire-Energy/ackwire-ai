import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { publishOrgEvent } from "@agenteschat/engine";
import { currentSubscriptions } from "../src/realtime/ws";
import {
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
  upgradeStatus,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const meOf = async (b: ReturnType<typeof browser>) =>
  (await (await b("/api/app/me")).json()) as { user: { id: string }; organizations: { id: string }[] };

test("a workspace being deleted: its sockets close and none opens; who you are and leaving still answer", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const ownerId = (await meOf(owner)).user.id;
  const anaId = (await meOf(ana)).user.id;
  const server = listen(t);
  const url = `ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`;
  const socket = new WebSocket(url, { headers: { origin: ORIGIN, cookie: owner.cookie() } } as unknown as string[]);
  const dueAt = new Date(Date.now() + 7 * 86_400_000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if ((JSON.parse(String(event.data)) as { type?: string }).type === "ready") resolve();
      });
      socket.addEventListener("error", () => reject(new Error("socket did not open")), { once: true });
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    expect(await currentSubscriptions(t.db, ownerId, orgId, [channelId])).toEqual(new Set([channelId]));

    await t.db.update(schema.organizations).set({ deletionDueAt: dueAt }).where(eq(schema.organizations.id, orgId));
    expect(await currentSubscriptions(t.db, ownerId, orgId, [channelId])).toBeNull();
    expect(await upgradeStatus(url, { origin: ORIGIN, cookie: owner.cookie() })).toBe(403);
    await publishOrgEvent(t.adapters.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.deleting", orgId, dueAt: dueAt.toISOString() },
    });
    expect(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])).toBe(4403);
  } finally {
    socket.close();
    await Promise.race([server.stop(true), Bun.sleep(500)]);
  }

  const refused = await owner(`/api/app/organizations/${orgId}/issues`);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({
    error: { code: "org.deleting", params: { dueAt: dueAt.toISOString() } },
  });
  expect((await meOf(ana)).organizations.map((o) => o.id)).toEqual([orgId]);
  expect((await ana(`/api/app/organizations/${orgId}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
  expect((await meOf(ana)).organizations).toEqual([]);
});
