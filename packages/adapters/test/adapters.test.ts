import { afterEach, describe, expect, test } from "bun:test";
import { createTestDatabase } from "@agenteschat/db/testing";
import type { PGlite } from "@electric-sql/pglite";
import {
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  createPostgresPubSub,
  PayloadTooLargeError,
  type PgNotifier,
  type PubSub,
  type RealtimeEvent,
} from "../src";

function pgliteNotifier(pg: PGlite): PgNotifier {
  return {
    async listen(channel, onPayload) {
      const unsub = await pg.listen(channel, onPayload);
      return async () => unsub();
    },
    async notify(channel, payload) {
      await pg.query("select pg_notify($1, $2)", [channel, payload]);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function contract(name: string, make: () => Promise<{ pubsub: PubSub; close: () => Promise<void> }>) {
  describe(`PubSub contract: ${name}`, () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await close?.();
    });

    test("delivers to subscribers of the topic only", async () => {
      const ctx = await make();
      close = ctx.close;
      const a: RealtimeEvent[] = [];
      const b: RealtimeEvent[] = [];
      ctx.pubsub.subscribe("channel:a", (e) => a.push(e));
      ctx.pubsub.subscribe("channel:b", (e) => b.push(e));
      await ctx.pubsub.publish("channel:a", { type: "x", n: 1 });
      await tick();
      expect(a).toEqual([{ type: "x", n: 1 }]);
      expect(b).toEqual([]);
    });

    test("unsubscribe stops delivery; a throwing handler doesn't break others", async () => {
      const ctx = await make();
      close = ctx.close;
      const got: RealtimeEvent[] = [];
      ctx.pubsub.subscribe("t", () => {
        throw new Error("boom");
      });
      const off = ctx.pubsub.subscribe("t", (e) => got.push(e));
      await ctx.pubsub.publish("t", { type: "one" });
      await tick();
      off();
      await ctx.pubsub.publish("t", { type: "two" });
      await tick();
      expect(got.map((e) => e.type)).toEqual(["one"]);
    });
  });
}

contract("memory", async () => ({ pubsub: createMemoryPubSub(), close: async () => {} }));
contract("postgres LISTEN/NOTIFY (PGlite)", async () => {
  const ctx = await createTestDatabase();
  if (!ctx.pglite) throw new Error("needs PGlite");
  const pubsub = await createPostgresPubSub(pgliteNotifier(ctx.pglite));
  return {
    pubsub,
    close: async () => {
      await pubsub.close?.();
      await ctx.close();
    },
  };
});

test("postgres pub/sub rejects payloads over the NOTIFY limit", async () => {
  const pubsub = await createPostgresPubSub({ listen: async () => async () => {}, notify: async () => {} });
  await expect(pubsub.publish("t", { type: "big", text: "x".repeat(9000) })).rejects.toBeInstanceOf(
    PayloadTooLargeError,
  );
});

test("memory presence tracks connections per user", async () => {
  const p = createMemoryPresence();
  await p.connect("o", "u1", "c1");
  await p.connect("o", "u1", "c2");
  await p.connect("o", "u2", "c3");
  await p.disconnect("o", "u1", "c1");
  expect(await p.online("o")).toEqual(["u1", "u2"]);
  await p.disconnect("o", "u1", "c2");
  expect(await p.online("o")).toEqual(["u2"]);
  expect(await p.online("other")).toEqual([]);
});

test("memory rate limiter uses fixed windows", async () => {
  let t = 0;
  const rl = createMemoryRateLimiter(() => t);
  const rule = { limit: 2, windowMs: 1000 };
  expect((await rl.consume("k", rule)).allowed).toBe(true);
  expect((await rl.consume("k", rule)).allowed).toBe(true);
  expect((await rl.consume("k", rule)).allowed).toBe(false);
  expect((await rl.consume("other", rule)).allowed).toBe(true);
  t = 1000;
  expect((await rl.consume("k", rule)).remaining).toBe(1);
});
