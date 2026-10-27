import { afterEach, describe, expect, test } from "bun:test";
import { createS3BlobStore, StorageError } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  artifactDownload,
  assertPublicHttpsUrl,
  createArtifact,
  createOrganization,
  deleteAccount,
  drainOutbox,
  enqueue,
  ForbiddenError,
  getArtifact,
  getMigration,
  getStorage,
  isBlockedAddress,
  ORG_FILES_PURGE_JOB,
  type S3Input,
  saveStorage,
  startMigration,
  testStorage,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SECRET = "secret-test-key-123456";
const bucket = (over: Partial<S3Input> = {}): S3Input => ({
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "acme-files",
  prefix: "agentes",
  pathStyle: true,
  accessKeyId: "AKIATEST",
  secretAccessKey: SECRET,
  ...over,
});
const person = (userId: string) => ({ type: "person" as const, userId });
const doc = (title: string) => ({ title, content: { kind: "document" as const, markdown: `# ${title}` } });

describe("S3 client against the fake server", () => {
  test("put, get, list, delete and a presigned GET, path-style and virtual-hosted", async () => {
    f = await setup();
    for (const pathStyle of [true, false]) {
      const store = createS3BlobStore(
        { ...bucket({ pathStyle }), accessKeyId: "AKIATEST", secretAccessKey: SECRET },
        { fetch: f.s3.fetch },
      );
      await store.put("a/b c.txt", new TextEncoder().encode("hi"), { contentType: "text/plain" });
      expect(new TextDecoder().decode((await store.get("a/b c.txt"))?.body)).toBe("hi");
      expect(await store.list("a/")).toEqual(["a/b c.txt"]);
      const url = (await store.signedUrl("a/b c.txt", { expiresInSeconds: 60, filename: "b.txt" })) ?? "";
      expect((await f.s3.fetch(url, { method: "GET" })).status).toBe(200);
      expect((await f.s3.fetch(url.replace(/X-Amz-Signature=\w+/, "X-Amz-Signature=00"), {})).status).toBe(403);
      await store.delete("a/b c.txt");
      expect(await store.get("a/b c.txt")).toBeNull();
    }
    const settings = { ...bucket(), accessKeyId: "AKIATEST", secretAccessKey: "nope" };
    const wrong = createS3BlobStore(settings, { fetch: f.s3.fetch });
    const error = await wrong.get("x").catch((e) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("auth");
  });
});

describe("org storage", () => {
  test("a failing test blocks activation, with a clear reason per failure", async () => {
    f = await setup();
    const cases: [Partial<S3Input>, string][] = [
      [{ secretAccessKey: "wrong-secret" }, "was not accepted"],
      [{ bucket: "missing" }, "doesn't exist"],
      [{ region: "eu-west-1" }, "region"],
    ];
    for (const [over, reason] of cases) {
      const result = await testStorage(f.storage, f.owner.id, f.org.id, bucket(over));
      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({ step: "write", ok: false, code: expect.stringMatching(/^storage\./) });
      expect(result.steps[0]?.error).toContain(reason);
      await expect(saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket(over) })).rejects.toThrow(
        "Test the connection",
      );
    }
    f.s3.state.denyDelete = true;
    const noDelete = await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    expect(noDelete.steps.map((s) => [s.step, s.ok])).toEqual([
      ["write", true],
      ["read", true],
      ["list", true],
      ["delete", false],
    ]);
    expect(noDelete.steps[3]?.error).toContain("no permission");
    expect((await getStorage(f.db, f.owner.id, f.org.id)).kind).toBe("agentes");
  });

  test("after a switch old files still read from where they were written; new files go to the bucket", async () => {
    f = await setup();
    const before = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Antes"));
    expect((await testStorage(f.storage, f.owner.id, f.org.id, bucket())).ok).toBe(true);
    const view = await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    expect(view).toMatchObject({ kind: "s3", s3: { bucket: "acme-files", prefix: "agentes" } });

    const after = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Depois"));
    const objects = [...(f.s3.buckets.get("acme-files")?.keys() ?? [])];
    expect(objects).toEqual([`agentes/artifacts/${after.id}/v1`]);
    expect(f.platformBlobs.objects.has(`orgs/${f.org.id}/artifacts/${before.id}/v1`)).toBe(true);
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, before.id)).content).toEqual(
      doc("Antes").content,
    );
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, after.id)).content).toEqual(
      doc("Depois").content,
    );
    // Downloads of bucket files are signed by the bucket (and the signature holds).
    const link = await artifactDownload(f.artifactDeps, f.owner.id, f.org.id, after.id);
    expect(link.url.startsWith(`https://s3.example.com/acme-files/agentes/artifacts/${after.id}/v1?`)).toBe(true);
    expect(await (await f.s3.fetch(link.url, { method: "GET" })).text()).toBe("# Depois");

    // Back to platform storage: new files go there; bucket files still read.
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "agentes" });
    const back = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("De volta"));
    expect(f.platformBlobs.objects.has(`orgs/${f.org.id}/artifacts/${back.id}/v1`)).toBe(true);
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, after.id)).title).toBe("Depois");
  });

  test("the migration copies old files to the bucket and resumes after a failure", async () => {
    f = await setup();
    const files = [];
    for (const t of ["Um", "Dois", "Três"]) {
      files.push(await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc(t)));
    }
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });

    // The second read fails: the job stops with progress saved.
    const realGet = f.platformBlobs.get;
    let reads = 0;
    f.platformBlobs.get = async (key) => {
      reads++;
      if (reads === 2) throw new StorageError("network", "boom");
      return realGet(key);
    };
    expect(await startMigration(f.storage, f.owner.id, f.org.id)).toMatchObject({ status: "running", total: 3 });
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "failed", copied: 1, total: 3 });

    f.platformBlobs.get = realGet;
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "done", copied: 3, total: 3 });
    const versions = await f.db.select().from(schema.artifactVersions);
    expect(versions.every((v) => v.storageConfigId !== null && v.blobKey.startsWith("agentes/"))).toBe(true);
    expect(f.s3.buckets.get("acme-files")?.size).toBe(3);
    for (const file of files) {
      const read = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, file.id);
      expect(read.content).toEqual(doc(file.title).content);
    }
    // Nothing left to copy: a new migration is done at once.
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "done", copied: 0, total: 0 });
  });

  test("credentials never leak: hints only, sealed at rest, not in the audit log", async () => {
    f = await setup();
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    const view = await getStorage(f.db, f.owner.id, f.org.id);
    expect(view.s3).toMatchObject({ accessKeyIdHint: "••••TEST", secretHint: "••••3456" });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const rows = await f.db.select().from(schema.storageConfigs);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, f.org.id));
    expect(audit.map((a) => a.action).sort()).toEqual(["storage.activated", "storage.test_passed"]);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    // Re-testing with empty keys reuses the stored ones.
    const again = await testStorage(f.storage, f.owner.id, f.org.id, {
      ...bucket(),
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(again.ok).toBe(true);
  });

  test("a deleted workspace's files leave platform storage a page at a time, and nobody else's go", async () => {
    f = await setup();
    const put = (key: string) => f.platformBlobs.put(key, new Uint8Array([1]), { contentType: "text/plain" });
    const { organization: second } = await createOrganization(f.db, f.owner.id, { name: "Two" });
    const bia = await addUser(f.db, "bia");
    const { organization: hers } = await createOrganization(f.db, bia.id, { name: "Bia's" });
    // A full page and one key more, then the logo.
    for (let i = 0; i <= 1000; i++) await put(`orgs/${f.org.id}/artifacts/a${i}/v1`);
    await put(`org-logos/${f.org.id}/logo.png`);
    await put(`orgs/${second.id}/skills/s/SKILL.md`);
    await put(`orgs/${second.id}/connector-icons/c/0123456789abcdef.png`);
    const kept = [`orgs/${hers.id}/artifacts/b/v1`, `org-logos/${hers.id}/logo.png`, `avatars/${bia.id}/me.png`];
    for (const key of kept) await put(key);
    const purges = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ORG_FILES_PURGE_JOB));
    const runsOf = async (orgId: string) => (await purges()).filter((j) => j.payload.orgId === orgId);

    expect((await deleteAccount(f.db, f.owner.id)).deletedOrgIds.sort()).toEqual([f.org.id, second.id].sort());
    const queued = (await purges()).map((j) => ({ orgId: j.orgId, payload: j.payload }));
    expect(queued).toEqual(
      expect.arrayContaining([
        { orgId: null, payload: { orgId: f.org.id } },
        { orgId: null, payload: { orgId: second.id } },
      ]),
    );
    expect(queued).toHaveLength(2);

    await drainOutbox(f.db, f.handlers);
    expect([...f.platformBlobs.objects.keys()].sort()).toEqual(kept.sort());
    // The full first page ran the job once more.
    expect((await runsOf(f.org.id)).map((j) => j.status)).toEqual(["done", "done"]);
    expect((await runsOf(second.id)).map((j) => j.status)).toEqual(["done"]);

    // Run again, nothing is left and nothing more is queued. A workspace that still exists keeps its files.
    for (const orgId of [f.org.id, hers.id])
      await enqueue(f.db, { orgId: null, kind: ORG_FILES_PURGE_JOB, payload: { orgId } });
    await drainOutbox(f.db, f.handlers);
    expect([...f.platformBlobs.objects.keys()].sort()).toEqual(kept.sort());
    expect(await runsOf(f.org.id)).toHaveLength(3);
    expect((await purges()).every((j) => j.status === "done")).toBe(true);
  });

  test("only admins manage storage", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(getStorage(f.db, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(testStorage(f.storage, bia.id, f.org.id, bucket())).rejects.toBeInstanceOf(ForbiddenError);
    const revert = saveStorage(f.storage, bia.id, f.org.id, { kind: "agentes" });
    await expect(revert).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startMigration(f.storage, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the SSRF guard holds: https only, no private, loopback, link-local or metadata addresses", async () => {
    f = await setup();
    const requests = f.s3.state.requests;
    const endpoints = [
      "http://s3.example.com",
      "https://169.254.169.254",
      "https://127.0.0.1:9000",
      "https://[::1]",
      "https://localhost",
      "https://minio.internal",
      "https://user:pass@s3.example.com",
      "https://storage.corp.test", // resolves to 10.0.0.5 in the fixture
    ];
    for (const endpoint of endpoints) {
      const result = await testStorage(f.storage, f.owner.id, f.org.id, bucket({ endpoint }));
      expect(result.ok).toBe(false);
      expect(result.steps[0]?.error).toBeTruthy();
    }
    expect(f.s3.state.requests).toBe(requests); // nothing was sent
    const blocked = ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::ffff:127.0.0.1", "fe80::1"];
    for (const ip of blocked) expect(isBlockedAddress(ip)).toBe(true);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    await expect(assertPublicHttpsUrl("https://s3.example.com", async () => ["93.184.216.34"])).resolves.toBeDefined();
    const metadata = assertPublicHttpsUrl("https://x.example.com", async () => ["169.254.169.254"]);
    await expect(metadata).rejects.toBeInstanceOf(ValidationError);
  });
});
