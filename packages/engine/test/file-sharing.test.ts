import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createArtifact,
  createChannel,
  createRole,
  deleteArtifact,
  ForbiddenError,
  fileReach,
  getArtifact,
  indexSource,
  listArtifacts,
  listDeletedArtifacts,
  NotFoundError,
  openDm,
  searchForUser,
  setFileSharing,
  setMemberRoles,
  type ValidationError,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const doc = (title: string, channelId: string | null = null) => ({
  title,
  channelId,
  content: { kind: "document" as const, markdown: `# ${title}` },
});

/** Bia's DM with the agent holds a report; Caio and Duda are other members, the owner an administrator. */
async function world() {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const duda = await addMember(f.db, f.org.id, "member", "duda");
  const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
  const file = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Relatório", dm.id));
  const reads = async (userId: string) => {
    const listed = (await listArtifacts(f.db, person(userId), f.org.id)).some((a) => a.id === file.id);
    const opened = await getArtifact(f.artifactDeps, person(userId), f.org.id, file.id).then(
      () => true,
      (e: unknown) => {
        if (e instanceof NotFoundError) return false;
        throw e;
      },
    );
    expect(listed).toBe(opened);
    return opened;
  };
  return { bia, caio, duda, dm, file, reads };
}

describe("a file's sharing (ADR 0153)", () => {
  test("conversation, the default: only the DM, administrators included out", async () => {
    const { bia, caio, file, reads } = await world();
    expect(file.sharing).toEqual({ mode: "conversation", userIds: [], roleIds: [] });
    expect(await reads(bia.id)).toBe(true);
    expect(await reads(caio.id)).toBe(false);
    expect(await reads(f.owner.id)).toBe(false);
  });

  test("people: who it names and administrators see it, nobody else; taking them out closes it again", async () => {
    const { bia, caio, duda, file, reads } = await world();
    const saved = await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, {
      mode: "people",
      userIds: [caio.id, "someone-not-here"],
    });
    expect(saved.sharing).toEqual({ mode: "people", userIds: [caio.id], roleIds: [] });
    expect(await reads(caio.id)).toBe(true);
    expect(await reads(f.owner.id)).toBe(true);
    expect(await reads(duda.id)).toBe(false);
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "conversation" });
    expect(await reads(caio.id)).toBe(false);
    expect(await reads(f.owner.id)).toBe(false);
  });

  test("people: a role reaches whoever holds it, now", async () => {
    const { bia, caio, duda, file, reads } = await world();
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Financeiro", permissions: [] });
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", roleIds: [finance.id] });
    expect(await reads(duda.id)).toBe(false);
    await setMemberRoles(f.db, f.owner.id, f.org.id, duda.id, [finance.id]);
    expect(await reads(duda.id)).toBe(true);
    expect(await reads(caio.id)).toBe(false);
  });

  test("everyone: every member, and the Drive moves it out of the private section", async () => {
    const { bia, caio, duda, file, reads } = await world();
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "everyone" });
    for (const id of [caio.id, duda.id, f.owner.id]) expect(await reads(id)).toBe(true);
    const [facts] = await withPersonFacts(f.db, caio.id, f.org.id, [
      await getArtifact(f.artifactDeps, person(caio.id), f.org.id, file.id),
    ]);
    expect(facts?.sharing.mode).toBe("everyone");
    // Caio reads it through the sharing, not the DM: he can't pass it on.
    expect(facts?.canShare).toBe(false);
  });

  test("who changes it: the DM's people; someone it was shared with gets a refusal, an outsider a not found", async () => {
    const { bia, caio, duda, file } = await world();
    const [mine] = await withPersonFacts(f.db, bia.id, f.org.id, [file]);
    expect(mine?.canShare).toBe(true);
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", userIds: [caio.id] });
    const refused = await setFileSharing(f.artifactDeps, caio.id, f.org.id, file.id, { mode: "everyone" }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).code).toBe("artifact.sharing_forbidden");
    await expect(
      setFileSharing(f.artifactDeps, duda.id, f.org.id, file.id, { mode: "everyone" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A file the whole workspace sees already has nothing to widen.
    const open = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Manual"));
    const widened = await setFileSharing(f.artifactDeps, bia.id, f.org.id, open.id, { mode: "everyone" }).catch(
      (e: unknown) => e,
    );
    expect((widened as ValidationError).code).toBe("artifact.sharing_open");
    const empty = await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, {
      mode: "people",
      userIds: [],
    }).catch((e: unknown) => e);
    expect((empty as ValidationError).code).toBe("artifact.sharing_empty");
  });

  test("a private channel's file: its members and administrators change it, an administrator from outside it too", async () => {
    const { caio, duda } = await world();
    const fin = await createChannel(f.db, caio.id, f.org.id, { name: "fin", visibility: "private" });
    const plan = await createArtifact(f.artifactDeps, person(caio.id), f.org.id, doc("Plano", fin.id));
    const [asAdmin] = await withPersonFacts(f.db, f.owner.id, f.org.id, [plan]);
    expect(asAdmin?.canShare).toBe(true);
    const saved = await setFileSharing(f.artifactDeps, f.owner.id, f.org.id, plan.id, {
      mode: "people",
      userIds: [duda.id],
    });
    expect(saved.sharing.userIds).toEqual([duda.id]);
    await expect(
      setFileSharing(f.artifactDeps, duda.id, f.org.id, plan.id, { mode: "everyone" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("each change is an audit row with the modes and the ids, never the title", async () => {
    const { bia, caio, file } = await world();
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", userIds: [caio.id] });
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "everyone" });
    const rows = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "artifact.sharing_changed"));
    expect(rows.map((r) => [r.actorId, r.targetId, r.details])).toEqual([
      [bia.id, file.id, { from: "conversation", mode: "people", userIds: [caio.id], roleIds: [] }],
      [bia.id, file.id, { from: "people", mode: "everyone", userIds: [], roleIds: [] }],
    ]);
    expect(JSON.stringify(rows)).not.toContain("Relatório");
  });

  test("search finds it for who it's shared with, and for nobody else", async () => {
    const { bia, caio, duda, file } = await world();
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    const found = async (userId: string) =>
      (await searchForUser(deps, userId, f.org.id, { text: "Relatório", kinds: ["file"] })).some(
        (h) => h.sourceId === file.id,
      );
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", userIds: [caio.id] });
    await indexSource(deps, { orgId: f.org.id, kind: "file", sourceId: file.id });
    expect(await found(bia.id)).toBe(true);
    expect(await found(caio.id)).toBe(true);
    expect(await found(duda.id)).toBe(false);
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "everyone" });
    await indexSource(deps, { orgId: f.org.id, kind: "file", sourceId: file.id });
    expect(await found(duda.id)).toBe(true);
  });

  test("the trash keeps it for whom it was shared with, and a deleted file is gone for them like for anyone", async () => {
    const { bia, file } = await world();
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", userIds: [f.owner.id] });
    await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
    await expect(getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, file.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // The owner, an administrator it's shared with, may restore it from the trash.
    expect((await listDeletedArtifacts(f.db, f.owner.id, f.org.id)).map((a) => a.id)).toContain(file.id);
  });
});

describe("agents and a shared file: the wiki's rule", () => {
  test("a run reaches it only where the person behind it and everyone in its conversation see it", async () => {
    const { bia, caio, file } = await world();
    const ownerDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const inOwnerDm = { type: "agent" as const, agentId: f.agent.id, channelId: ownerDm.id };
    const inGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const listedFor = async (actor: typeof inOwnerDm, requesterUserId: string | null) =>
      (await listArtifacts(f.db, actor, f.org.id, { requesterUserId })).some((a) => a.id === file.id);
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", userIds: [f.owner.id] });
    // The owner's DM: the owner sees it, and nobody else reads that DM.
    expect(await listedFor(inOwnerDm, f.owner.id)).toBe(true);
    // #general is read by the whole workspace, and Caio doesn't see it.
    expect(await listedFor(inGeneral, f.owner.id)).toBe(false);
    // A private channel with Caio in it: the same, member by member.
    const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, ops.id, { userId: caio.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, ops.id, { agentId: f.agent.id });
    const inOps = { type: "agent" as const, agentId: f.agent.id, channelId: ops.id };
    expect(await listedFor(inOps, f.owner.id)).toBe(false);
    // Nobody behind the run: no list of people opens for nobody.
    expect(await listedFor(inOwnerDm, null)).toBe(false);
    await expect(getArtifact(f.artifactDeps, inGeneral, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
    // Shared with everyone: every run reaches it, with or without a person.
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "everyone" });
    expect(await listedFor(inGeneral, caio.id)).toBe(true);
    expect((await getArtifact(f.artifactDeps, inGeneral, f.org.id, file.id)).id).toBe(file.id);
  });

  test("fileReach says who it was shared with", async () => {
    const { bia, caio, file } = await world();
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "people", userIds: [caio.id] });
    expect(await fileReach(f.db, f.org.id, file.id)).toStartWith(
      "Who reads its conversation sees it, and it is also shared with caio and administrators: it is in the Drive's private section",
    );
    await setFileSharing(f.artifactDeps, bia.id, f.org.id, file.id, { mode: "everyone" });
    expect(await fileReach(f.db, f.org.id, file.id)).toBe(
      "It was shared with the whole workspace: everyone in the workspace sees it.",
    );
  });
});
