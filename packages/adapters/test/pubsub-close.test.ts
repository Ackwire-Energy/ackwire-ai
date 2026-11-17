import { expect, test } from "bun:test";
import { createPostgresPubSub } from "../src/pubsub";

test("closing during a reconnect waits for and removes the replacement LISTEN", async () => {
  const replacing = Promise.withResolvers<void>();
  const replace = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  const pubsub = await createPostgresPubSub(
    {
      async listen() {
        calls++;
        if (calls === 2) {
          replacing.resolve();
          await replace.promise;
        }
        active++;
        let removed = false;
        return async () => {
          if (!removed) active--;
          removed = true;
        };
      },
      async notify() {},
    },
    { heartbeatMs: 5 },
  );
  await replacing.promise;
  const closing = pubsub.close?.();
  replace.resolve();
  await closing;
  await Bun.sleep(10);
  expect(active).toBe(0);
  expect(calls).toBe(2);
});

test("close still flushes notifications already queued", async () => {
  const sent: string[] = [];
  let removed = false;
  const pubsub = await createPostgresPubSub({
    async listen() {
      return async () => {
        removed = true;
      };
    },
    async notify(_channel, payload) {
      sent.push(payload);
    },
  });
  await pubsub.publish("work", { type: "done" });
  await pubsub.close?.();
  expect(sent).toEqual([JSON.stringify({ t: "work", e: { type: "done" } })]);
  expect(removed).toBe(true);
});
