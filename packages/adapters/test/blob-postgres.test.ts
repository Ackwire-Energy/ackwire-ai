import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createPostgresBlobStore } from "../src";

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(() => close());

const bytes = (s: string) => new TextEncoder().encode(s);
const png = { contentType: "image/png" };

test("an org's files and logo carry the org and go with it; a person's photo belongs to no org", async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Acme" }).returning();
  if (!org) throw new Error("no org");
  const store = createPostgresBlobStore(db);
  const photo = "avatars/u1/0123456789abcdef.png";
  await store.put(`orgs/${org.id}/artifacts/a1/v1`, bytes("%PDF"), { contentType: "application/pdf" });
  await store.put(`org-logos/${org.id}/0123456789abcdef.png`, bytes("logo"), png);
  await store.put(photo, bytes("photo"), png);
  await store.put(photo, bytes("new photo"), png);

  expect(await store.get(photo)).toEqual({ body: bytes("new photo"), contentType: "image/png" });
  expect(await store.list("avatars/u1/")).toEqual([photo]);
  const rows = await db
    .select({ key: schema.blobs.key, orgId: schema.blobs.orgId })
    .from(schema.blobs)
    .orderBy(schema.blobs.key);
  expect(rows).toEqual([
    { key: photo, orgId: null },
    { key: `org-logos/${org.id}/0123456789abcdef.png`, orgId: org.id },
    { key: `orgs/${org.id}/artifacts/a1/v1`, orgId: org.id },
  ]);

  await db.delete(schema.organizations).where(eq(schema.organizations.id, org.id));
  expect(await store.list("")).toEqual([photo]);
  await store.delete(photo);
  expect(await store.get(photo)).toBeNull();
});

test("a feedback's file belongs to no org and is listed under feedback/", async () => {
  const store = createPostgresBlobStore(db);
  const shot = "feedback/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  await store.put(shot, bytes("shot"), png);

  expect(await store.get(shot)).toEqual({ body: bytes("shot"), contentType: "image/png" });
  expect(await store.list("feedback/")).toEqual([shot]);
  expect(await db.select({ orgId: schema.blobs.orgId }).from(schema.blobs)).toEqual([{ orgId: null }]);
  await store.delete(shot);
  expect(await store.list("feedback/")).toEqual([]);
});

test("any other key is refused", async () => {
  const store = createPostgresBlobStore(db);
  const keys = ["skills/s1/v1/a.md", "orgs/acme/a", "org-logos/acme/a.png", "avatars//a.png", "avatars/u1", ""];
  keys.push("feedback/abc", "feedback/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/x.png");
  for (const key of keys) {
    await expect(store.put(key, bytes("x"), { contentType: "text/plain" })).rejects.toThrow(/blob key/);
  }
  expect(await db.select().from(schema.blobs)).toEqual([]);
});
