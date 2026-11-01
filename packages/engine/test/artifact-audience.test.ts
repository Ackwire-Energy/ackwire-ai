import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createArtifact,
  createChannel,
  deleteArtifact,
  ForbiddenError,
  getArtifact,
  listArtifacts,
  listDeletedArtifacts,
  NotFoundError,
  openDm,
  purgeArtifactNow,
  restoreArtifact,
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

test("who can see a file, per source: workspace, public channel, private channel, DM with an agent or a person", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
  const withAgent = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
  const withOwner = await openDm(f.db, bia.id, f.org.id, { userId: f.owner.id });
  const files = {
    drive: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Manual")),
    general: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Pauta", f.general.id)),
    secret: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Plano", secret.id)),
    agentDm: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Rascunho", withAgent.id)),
    ownerDm: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Recibo", withOwner.id)),
  };
  const facts = await withPersonFacts(f.db, bia.id, f.org.id, await listArtifacts(f.db, person(bia.id), f.org.id));
  const audience = (id: string) => facts.find((a) => a.id === id)?.audience;
  expect(audience(files.drive.id)).toEqual({ kind: "workspace" });
  expect(audience(files.general.id)).toEqual({ kind: "channel", name: f.general.name, private: false });
  expect(audience(files.secret.id)).toEqual({ kind: "channel", name: "secret", private: true });
  expect(audience(files.agentDm.id)).toEqual({ kind: "dm", with: { type: "agent", id: f.agent.id } });
  expect(audience(files.ownerDm.id)).toEqual({ kind: "dm", with: { type: "person", id: f.owner.id } });
  // The owner, on the other side of the same DM, sees bia.
  const [fromOwner] = await withPersonFacts(f.db, f.owner.id, f.org.id, [
    await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, files.ownerDm.id),
  ]);
  expect(fromOwner?.audience).toEqual({ kind: "dm", with: { type: "person", id: bia.id } });
});

test("a DM's files stay in the DM: other people, admins included, and agents outside it never see them", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const dm = await openDm(f.db, bia.id, f.org.id, { userId: caio.id });
  const file = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Recibo", dm.id));
  for (const outsider of [f.owner.id]) {
    expect((await listArtifacts(f.db, person(outsider), f.org.id)).map((a) => a.id)).not.toContain(file.id);
    await expect(getArtifact(f.artifactDeps, person(outsider), f.org.id, file.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  }
  const agentInGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  expect((await listArtifacts(f.db, agentInGeneral, f.org.id)).map((a) => a.id)).not.toContain(file.id);
  expect((await listArtifacts(f.db, person(caio.id), f.org.id)).map((a) => a.id)).toContain(file.id);
});

test("canDelete: the creator, the agent's owner and admins; not other members", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await f.db.update(schema.agents).set({ ownerUserId: caio.id }).where(eq(schema.agents.id, f.agent.id));
  const mine = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Meu"));
  const agents = await createArtifact(
    f.artifactDeps,
    { type: "agent", agentId: f.agent.id, channelId: f.general.id },
    f.org.id,
    doc("Do agente"),
  );
  const can = async (userId: string) =>
    Object.fromEntries(
      (await withPersonFacts(f.db, userId, f.org.id, [mine, agents])).map((a) => [a.title, a.canDelete]),
    );
  expect(await can(bia.id)).toEqual({ Meu: true, "Do agente": false });
  expect(await can(caio.id)).toEqual({ Meu: false, "Do agente": true });
  expect(await can(f.owner.id)).toEqual({ Meu: true, "Do agente": true });
});

test("delete for good from the trash: contents gone now, out of the trash, no restore; same people only", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const file = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Velho"));
  // Only from the trash.
  await expect(purgeArtifactNow(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  await expect(purgeArtifactNow(f.artifactDeps, caio.id, f.org.id, file.id)).rejects.toBeInstanceOf(ForbiddenError);
  const [version] = await f.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, file.id));
  expect(f.platformBlobs.objects.has(version?.blobKey ?? "")).toBe(true);

  await purgeArtifactNow(f.artifactDeps, bia.id, f.org.id, file.id);
  expect(f.platformBlobs.objects.has(version?.blobKey ?? "")).toBe(false);
  expect(
    await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, file.id)),
  ).toEqual([]);
  expect(await listDeletedArtifacts(f.db, bia.id, f.org.id)).toEqual([]);
  await expect(restoreArtifact(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toMatchObject({
    code: "artifact.purged",
  });
  await expect(purgeArtifactNow(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  expect((await f.db.select().from(schema.auditLog)).map((a) => a.action)).toContain("artifact.purged");
});

test("agents' tools never see a trashed file", async () => {
  f = await setup();
  const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  const file = await createArtifact(f.artifactDeps, agent, f.org.id, doc("Relatório"));
  expect((await listArtifacts(f.db, agent, f.org.id)).map((a) => a.id)).toContain(file.id);
  await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
  expect((await listArtifacts(f.db, agent, f.org.id)).map((a) => a.id)).not.toContain(file.id);
  await expect(getArtifact(f.artifactDeps, agent, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
});
