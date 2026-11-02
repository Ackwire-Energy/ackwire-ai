import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createChannel, indexSource, searchForUser } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const day = (d: string) => new Date(`${d}T12:00:00Z`);

/** A message written straight to the table (any author, mentions, meta, date) and indexed. */
async function message(
  fx: Fixture,
  input: {
    channelId?: string;
    body: string;
    agent?: boolean;
    userId?: string;
    mentionedUserIds?: string[];
    mentionedAgentIds?: string[];
    meta?: Record<string, unknown>;
    at?: Date;
  },
) {
  const [m] = await fx.db
    .insert(schema.messages)
    .values({
      orgId: fx.org.id,
      channelId: input.channelId ?? fx.general.id,
      authorType: input.agent ? "agent" : "person",
      authorUserId: input.agent ? null : (input.userId ?? fx.owner.id),
      authorAgentId: input.agent ? fx.agent.id : null,
      body: input.body,
      mentionedUserIds: input.mentionedUserIds ?? [],
      mentionedAgentIds: input.mentionedAgentIds ?? [],
      meta: input.meta ?? {},
      createdAt: input.at ?? day("2026-10-15"),
    })
    .returning();
  if (!m) throw new Error("no message");
  await indexSource(deps(fx), { orgId: fx.org.id, kind: "message", sourceId: m.id });
  return m;
}

const deps = (fx: Fixture) => ({ db: fx.db, search: fx.search, gateway: fx.gateway });
const bodies = (hits: { snippet: string }[]) => hits.map((h) => h.snippet).sort();

describe("search filters (ADR 0123)", () => {
  test("from, author type, mentions, has, pinned, dates and sort, with and without words", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const image = await f.db
      .insert(schema.artifacts)
      .values({
        orgId: f.org.id,
        kind: "file",
        title: "photo.png",
        channelId: f.general.id,
        createdByType: "person",
        createdById: f.owner.id,
        updatedByType: "person",
        updatedById: f.owner.id,
      })
      .returning();
    const imageId = image[0]?.id as string;
    await f.db.insert(schema.artifactVersions).values({
      orgId: f.org.id,
      artifactId: imageId,
      version: 1,
      blobKey: "k",
      contentType: "image/png",
      size: 1,
      sha256: "x",
      authorType: "person",
      authorId: f.owner.id,
    });
    const plain = await message(f, { body: "deploy notes", at: day("2026-09-10") });
    await message(f, { body: "deploy done see https://example.test/run", agent: true, at: day("2026-10-02") });
    await message(f, {
      body: "deploy report attached",
      agent: true,
      mentionedUserIds: [member.id],
      meta: { artifacts: [{ id: crypto.randomUUID(), version: 1, title: "report.pdf" }] },
      at: day("2026-10-20"),
    });
    await message(f, {
      body: "deploy screenshot",
      meta: { artifacts: [{ id: imageId, version: 1, title: "photo.png" }] },
      mentionedAgentIds: [f.agent.id],
      at: day("2026-10-25"),
    });
    await message(f, { body: "approve the deploy?", agent: true, meta: { approvalId: crypto.randomUUID() } });
    await message(f, { body: "party gif", meta: { media: { kind: "gif", id: "g1" } }, at: day("2026-10-26") });
    await f.db.insert(schema.messagePins).values({
      orgId: f.org.id,
      channelId: f.general.id,
      messageId: plain.id,
      messageCreatedAt: plain.createdAt,
    });

    const find = (
      text: string,
      filters: Parameters<typeof searchForUser>[3] extends infer I ? Omit<I, "text"> : never,
    ) => searchForUser(deps(f), f.owner.id, f.org.id, { text, ...filters });

    expect(bodies(await find("deploy", { messages: { fromAgentIds: [f.agent.id] } }))).toEqual([
      "approve the deploy?",
      "deploy done see https://example.test/run",
      "deploy report attached",
    ]);
    // Either author in `from`, any mention in `mentions`.
    expect(
      bodies(await find("deploy", { messages: { fromUserIds: [member.id], fromAgentIds: [f.agent.id] } })),
    ).toHaveLength(3);
    expect(bodies(await find("deploy", { messages: { authorType: "person" } }))).toEqual([
      "deploy notes",
      "deploy screenshot",
    ]);
    expect(
      bodies(await find("", { messages: { mentionsUserIds: [member.id], mentionsAgentIds: [f.agent.id] } })),
    ).toEqual(["deploy report attached", "deploy screenshot"]);
    expect(bodies(await find("", { messages: { has: ["link"] } }))).toEqual([
      "deploy done see https://example.test/run",
    ]);
    expect(bodies(await find("", { messages: { has: ["file"] } }))).toEqual([
      "deploy report attached",
      "deploy screenshot",
    ]);
    expect(bodies(await find("", { messages: { has: ["image"] } }))).toEqual(["deploy screenshot", "party gif"]);
    expect(bodies(await find("", { messages: { has: ["card"] } }))).toEqual(["approve the deploy?"]);
    expect(bodies(await find("", { messages: { has: ["file", "image"] } }))).toEqual(["deploy screenshot"]);
    expect(bodies(await find("", { messages: { pinned: true } }))).toEqual(["deploy notes"]);
    // Dates: after is inclusive, before exclusive.
    expect(bodies(await find("deploy", { after: day("2026-10-01"), before: day("2026-10-21") }))).toEqual([
      "approve the deploy?",
      "deploy done see https://example.test/run",
      "deploy report attached",
    ]);
    // By date, with or without words.
    const newest = await find("deploy", { sort: "newest" });
    expect(newest.map((h) => h.snippet)).toEqual([
      "deploy screenshot",
      "deploy report attached",
      "approve the deploy?",
      "deploy done see https://example.test/run",
      "deploy notes",
    ]);
    expect((await find("deploy", { sort: "oldest" })).map((h) => h.snippet)).toEqual(
      newest.map((h) => h.snippet).reverse(),
    );
    expect((await find("", { messages: { authorType: "person" }, sort: "oldest" }))[0]?.snippet).toBe("deploy notes");
    // No words and no filter: nothing.
    expect(await find("", {})).toEqual([]);
  });

  test("in: searches only those channels, never one the person can't read", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops", visibility: "public" });
    await message(f, { channelId: secret.id, body: "budget secret" });
    await message(f, { channelId: ops.id, body: "budget ops" });
    await message(f, { body: "budget general" });

    const owner = (channelIds: string[], text = "budget") =>
      searchForUser(deps(f), f.owner.id, f.org.id, { text, channelIds });
    expect(bodies(await owner([ops.id]))).toEqual(["budget ops"]);
    expect(bodies(await owner([ops.id, secret.id]))).toEqual(["budget ops", "budget secret"]);
    // Only a channel scope: every message there, newest first.
    expect(bodies(await owner([secret.id], ""))).toEqual(["budget secret"]);
    // A channel the person isn't in is never searched, even asked for by id, and never widens to everything.
    const asMember = (channelIds: string[], text = "budget") =>
      searchForUser(deps(f), member.id, f.org.id, { text, channelIds });
    expect(await asMember([secret.id])).toEqual([]);
    expect(await asMember([secret.id], "")).toEqual([]);
    expect(await searchForUser(deps(f), member.id, f.org.id, { text: "", messages: { authorType: "person" } })).toEqual(
      [],
    );
  });
});
