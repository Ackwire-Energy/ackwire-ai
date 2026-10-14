import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPostgresSearchResolver } from "@agenteschat/adapters";
import { createChannel, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

test("postgres search stub only returns documents of visible channels in the org", async () => {
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "launch window is friday" });
  await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "launch budget is 100%_secret" });
  const index = await createPostgresSearchResolver(f.db).forOrg(f.org.id);
  expect(index.backend).toBe("postgres");
  expect((await index.query({ text: "launch", visibleChannelIds: [f.general.id] })).map((h) => h.snippet)).toEqual([
    "launch window is friday",
  ]);
  expect(await index.query({ text: "launch", visibleChannelIds: [] })).toEqual([]);
  // LIKE wildcards in the query are literal.
  expect((await index.query({ text: "100%_", visibleChannelIds: [f.general.id, secret.id] })).length).toBe(1);
  // Another org sees nothing, even with the channel ids.
  const other = await createPostgresSearchResolver(f.db).forOrg(crypto.randomUUID());
  expect(await other.query({ text: "launch", visibleChannelIds: [f.general.id] })).toEqual([]);
});
