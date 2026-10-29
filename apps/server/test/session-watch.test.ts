import { afterEach, beforeEach, expect, test } from "bun:test";
import { createMemoryPubSub, STREAM_CLOSE } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { recheckStream, type Stream } from "@agenteschat/engine";
import { SESSION_ENDED, sessionTopic } from "../src/auth";
import { createSessionWatch } from "../src/realtime/session-watch";

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  await db.insert(schema.users).values({ id: "u-1", name: "Dev", email: "dev@acme.test" });
  await db.insert(schema.sessions).values(
    ["s-1", "s-2"].map((id) => ({
      id,
      token: `token-${id}`,
      userId: "u-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    })),
  );
});
afterEach(() => close());

/** After the endings queued as microtasks ran. */
const tick = () => Bun.sleep(0);

test("an ended session announced on its topic closes only the sockets opened with it", async () => {
  const pubsub = createMemoryPubSub();
  const watch = createSessionWatch({ db, pubsub });
  const ended: string[] = [];
  const offA = watch.watch("u-1", "s-1", () => ended.push("a"));
  watch.watch("u-1", "s-1", () => ended.push("b"));
  watch.watch("u-1", "s-2", () => ended.push("c"));
  offA();
  await pubsub.publish(sessionTopic("u-1"), { type: SESSION_ENDED, sessionId: "s-1" });
  await tick();
  expect(ended).toEqual(["b"]);
  // Once is enough: a second announcement finds nothing left.
  await pubsub.publish(sessionTopic("u-1"), { type: SESSION_ENDED, sessionId: "s-1" });
  await tick();
  expect(ended).toEqual(["b"]);
});

test("the periodic check catches what no event announced: a deleted row, an expired session", async () => {
  const watch = createSessionWatch({ db, pubsub: createMemoryPubSub() });
  const ended: string[] = [];
  watch.watch("u-1", "s-1", () => ended.push("s-1"));
  watch.watch("u-1", "s-2", () => ended.push("s-2"));
  await watch.sweep();
  await tick();
  expect(ended).toEqual([]);
  await db.delete(schema.sessions).where(eq(schema.sessions.id, "s-1"));
  await db
    .update(schema.sessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.sessions.id, "s-2"));
  await watch.sweep();
  await tick();
  expect(ended.sort()).toEqual(["s-1", "s-2"]);
});

test("a desktop or terminal stream's 30 s recheck ends it once its session is gone", async () => {
  const stream = { sessionId: "s-1", userId: "u-1", orgId: "o", agentId: "a" } as unknown as Stream;
  await db.delete(schema.sessions).where(eq(schema.sessions.id, "s-1"));
  expect(await recheckStream(db, stream)).toEqual({ refused: STREAM_CLOSE.forbidden, reason: "signed_out" });
});
