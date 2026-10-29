import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  ARTIFACT_LIMITS,
  type ArtifactActor,
  addFileVersion,
  artifactDownload,
  artifactFile,
  ConflictError,
  cleanFileName,
  completeUpload,
  createArtifact,
  createFileArtifact,
  createUpload,
  deleteArtifact,
  drainOutbox,
  ForbiddenError,
  fileContentType,
  getArtifact,
  grantScopes,
  listArtifacts,
  listDeletedArtifacts,
  postPersonMessage,
  receiveMachineUpload,
  restoreArtifact,
  type ToolContext,
  UploadTimeoutError,
  updateArtifact,
  ValidationError,
  waitForUpload,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DRIVE = ["drive:read", "drive:write"].map((scope) => ({ connectionId: null, scope }));
const bytesOf = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const person = (): ArtifactActor => ({ type: "person", userId: f.owner.id });
const agentActor = (): ArtifactActor => ({ type: "agent", agentId: f.agent.id, channelId: f.general.id });
const uploadDeps = () => ({ db: f.db, artifacts: f.artifactDeps, pubsub: f.pubsub });
const uploadRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.artifactUploads).where(eq(schema.artifactUploads.id, id));
  return row;
};
const newUpload = (extra: Partial<Parameters<typeof createUpload>[1]> = {}) =>
  createUpload(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    computer: "fake:test",
    path: "out/report.pdf",
    ...extra,
  });

/** A real run (steps and usage rows reference it) in #general. */
async function runCtx(): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
  };
}

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

describe("file names and types", () => {
  test("names lose folders and control characters, keep the extension when cut", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\ana\\relatório final.pdf")).toBe("relatório final.pdf");
    expect(cleanFileName('a"b\u0007.txt')).toBe("ab.txt");
    const long = cleanFileName(`${"x".repeat(300)}.pdf`);
    expect(long).toHaveLength(ARTIFACT_LIMITS.fileNameChars);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(() => cleanFileName("  ")).toThrow(ValidationError);
    expect(() => cleanFileName("dir/")).toThrow(ValidationError);
  });

  test("types come from the extension; an unknown one keeps a plain given type, never one a browser runs", () => {
    expect(fileContentType("a.PDF")).toBe("application/pdf");
    expect(fileContentType("photo.jpeg", "text/html")).toBe("image/jpeg");
    expect(fileContentType("data.parquet", "application/x-parquet")).toBe("application/x-parquet");
    expect(fileContentType("page.weird", "text/html")).toBe("application/octet-stream");
    expect(fileContentType("img.weird", "image/svg+xml")).toBe("application/octet-stream");
    expect(fileContentType("noext")).toBe("application/octet-stream");
  });
});

describe("file artifacts", () => {
  test("created from bytes: metadata, untrusted, original bytes, name and type on download", async () => {
    f = await setup();
    const a = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Logo",
      name: "logo.png",
      bytes: PNG,
    });
    expect(a).toMatchObject({
      kind: "file",
      version: 1,
      untrusted: true,
      canEdit: true,
      channelId: null,
      content: { kind: "file", name: "logo.png", contentType: "image/png", size: PNG.byteLength },
    });
    expect(a.content.kind === "file" && a.content.sha256).toMatch(/^[0-9a-f]{64}$/);
    const read = await getArtifact(f.artifactDeps, person(), f.org.id, a.id);
    expect(read.content).toEqual(a.content);
    expect("text" in read.content).toBe(false);
    const file = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id);
    expect(file).toEqual({ body: PNG, contentType: "image/png", filename: "logo.png" });
    expect((await artifactDownload(f.artifactDeps, f.owner.id, f.org.id, a.id)).url).toContain("memory://");
    await expect(artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { format: "pdf" })).rejects.toThrow(
      ValidationError,
    );
    await expect(artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { format: "docx" })).rejects.toThrow(
      "not available for uploaded files",
    );
    // Search sees the title and the file name only.
    const [row] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, a.id));
    expect(row).toMatchObject({ kind: "file", untrusted: true, excerpt: "logo.png" });
    const [v] = await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, a.id));
    expect(v).toMatchObject({ fileName: "logo.png", contentType: "image/png", size: PNG.byteLength });
    expect((await listArtifacts(f.db, person(), f.org.id, { kind: "file" })).map((x) => x.id)).toEqual([a.id]);
  });

  test("small UTF-8 text files come with their text", async () => {
    f = await setup();
    const csv = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Dados",
      name: "dados.csv",
      bytes: bytesOf("a,b\n1,2\n"),
    });
    expect((await getArtifact(f.artifactDeps, person(), f.org.id, csv.id)).content).toMatchObject({
      kind: "file",
      contentType: "text/csv; charset=utf-8",
      text: "a,b\n1,2\n",
    });
    const notUtf8 = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Latin",
      name: "latin.txt",
      bytes: new Uint8Array([0x6f, 0x6c, 0xe1]),
    });
    expect("text" in (await getArtifact(f.artifactDeps, person(), f.org.id, notUtf8.id)).content).toBe(false);
  });

  test("versions keep each name; only files get them; JSON can't make or edit a file", async () => {
    f = await setup();
    const a = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Relatório",
      name: "relatorio.pdf",
      bytes: bytesOf("%PDF-1"),
    });
    const v2 = await addFileVersion(f.artifactDeps, person(), f.org.id, a.id, {
      name: "relatorio-v2.pdf",
      bytes: bytesOf("%PDF-2"),
      note: "revisado",
    });
    expect(v2).toMatchObject({ version: 2, shownVersion: 2, content: { name: "relatorio-v2.pdf", size: 6 } });
    expect((await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { version: 1 })).filename).toBe(
      "relatorio.pdf",
    );
    await expect(
      addFileVersion(f.artifactDeps, person(), f.org.id, a.id, { name: "x.pdf", bytes: PNG, baseVersion: 1 }),
    ).rejects.toThrow(ConflictError);

    const doc = await createArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Doc",
      content: { kind: "document", markdown: "# oi" },
    });
    await expect(
      addFileVersion(f.artifactDeps, person(), f.org.id, doc.id, { name: "x.pdf", bytes: PNG }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createArtifact(f.artifactDeps, person(), f.org.id, {
        title: "Falso",
        content: { kind: "file", name: "x.pdf", contentType: "application/pdf", size: 1, sha256: "0" },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      updateArtifact(f.artifactDeps, person(), f.org.id, a.id, { content: { kind: "document", markdown: "x" } }),
    ).rejects.toThrow(ValidationError);
  });

  test("at most 50 MB; a name is required", async () => {
    f = await setup();
    const big = new Uint8Array(ARTIFACT_LIMITS.fileBytes + 1);
    const error = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Grande",
      name: "big.bin",
      bytes: big,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("artifact.file_too_large");
    await expect(
      createFileArtifact(f.artifactDeps, person(), f.org.id, { title: "Sem nome", name: "/", bytes: PNG }),
    ).rejects.toThrow(ValidationError);
    expect(await f.db.select().from(schema.artifacts)).toHaveLength(0);
  });

  test("trash and restore", async () => {
    f = await setup();
    const a = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Logo",
      name: "logo.png",
      bytes: PNG,
    });
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, a.id);
    await expect(getArtifact(f.artifactDeps, person(), f.org.id, a.id)).rejects.toThrow("not found");
    const trash = await listDeletedArtifacts(f.db, f.owner.id, f.org.id);
    expect(trash.map((x) => [x.id, x.kind])).toEqual([[a.id, "file"]]);
    await restoreArtifact(f.artifactDeps, f.owner.id, f.org.id, a.id);
    expect((await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id)).body).toEqual(PNG);
  });
});

describe("uploads", () => {
  test("completed as the agent in its run's channel; audited; a second completion is refused", async () => {
    f = await setup();
    const up = await newUpload({ title: "Relatório", note: "do computador" });
    expect(up).toMatchObject({ status: "pending", maxBytes: ARTIFACT_LIMITS.fileBytes });
    expect(up.expiresAt.getTime() - up.createdAt.getTime()).toBe(10 * 60_000);
    const { upload, artifact } = await completeUpload(uploadDeps(), up.id, {
      name: "report.pdf",
      bytes: bytesOf("%PDF-1.7"),
      sha256: new Bun.CryptoHasher("sha256").update(bytesOf("%PDF-1.7")).digest("hex"),
    });
    expect(upload).toMatchObject({ status: "done", artifactId: artifact.id, version: 1 });
    expect(artifact).toMatchObject({
      kind: "file",
      title: "Relatório",
      channelId: f.general.id,
      createdBy: { type: "agent", id: f.agent.id },
      content: { name: "report.pdf", contentType: "application/pdf" },
    });
    const audit = (await f.db.select().from(schema.auditLog)).find((x) => x.action === "artifact.uploaded");
    expect(audit?.details).toMatchObject({ path: "out/report.pdf", size: 8, computer: "fake:test", uploadId: up.id });
    await expect(completeUpload(uploadDeps(), up.id, { name: "again.pdf", bytes: PNG })).rejects.toThrow(ConflictError);
  });

  test("a new version of the target file", async () => {
    f = await setup();
    const a = await createFileArtifact(f.artifactDeps, agentActor(), f.org.id, {
      title: "Gráfico",
      name: "g.png",
      bytes: PNG,
    });
    const up = await newUpload({ targetArtifactId: a.id, path: "g.png" });
    const { artifact } = await completeUpload(uploadDeps(), up.id, { name: "g.png", bytes: PNG.slice(0, 4) });
    expect(artifact).toMatchObject({ id: a.id, version: 2, content: { size: 4 } });
    expect(await uploadRow(up.id)).toMatchObject({ status: "done", artifactId: a.id, version: 2 });
  });

  test("refused: damaged, too large, expired; those fail the upload", async () => {
    f = await setup();
    const damaged = await newUpload();
    const e1 = await completeUpload(uploadDeps(), damaged.id, {
      name: "a.pdf",
      bytes: PNG,
      sha256: "0".repeat(64),
    }).catch((e) => e);
    expect(e1).toBeInstanceOf(ValidationError);
    expect(e1.code).toBe("upload.sha_mismatch");
    expect(await uploadRow(damaged.id)).toMatchObject({ status: "failed" });

    const small = await newUpload({ maxBytes: 3 });
    const e2 = await completeUpload(uploadDeps(), small.id, { name: "a.png", bytes: PNG }).catch((e) => e);
    expect(e2.code).toBe("artifact.file_too_large");
    expect(await uploadRow(small.id)).toMatchObject({ status: "failed" });

    const old = await newUpload({ now: new Date(Date.now() - 11 * 60_000) });
    const e3 = await completeUpload(uploadDeps(), old.id, { name: "a.png", bytes: PNG }).catch((e) => e);
    expect(e3).toBeInstanceOf(ConflictError);
    expect(e3.code).toBe("upload.expired");
    expect(await uploadRow(old.id)).toMatchObject({ status: "failed" });
    expect(await f.db.select().from(schema.artifacts)).toHaveLength(0);
  });

  test("a machine's upload: only that machine completes it; another one doesn't fail it", async () => {
    f = await setup();
    const machineId = crypto.randomUUID();
    const up = await newUpload({ machineId, computer: `machine:${machineId}` });
    const body = bytesOf("hello");
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const input = { uploadId: up.id, name: "hello.txt", contentType: "text/plain", sha256, body };
    await expect(receiveMachineUpload(uploadDeps(), { ...input, machineId: crypto.randomUUID() })).rejects.toThrow(
      ForbiddenError,
    );
    // The server itself can't complete a machine's upload either.
    await expect(completeUpload(uploadDeps(), up.id, { name: "x.txt", bytes: body })).rejects.toThrow(ForbiddenError);
    expect(await uploadRow(up.id)).toMatchObject({ status: "pending" });
    const { artifact } = await receiveMachineUpload(uploadDeps(), { ...input, machineId });
    expect(artifact.content).toMatchObject({ kind: "file", name: "hello.txt", text: "hello" });
    // And a machine can't complete an upload the server reads.
    const serverSide = await newUpload();
    await expect(receiveMachineUpload(uploadDeps(), { ...input, uploadId: serverSide.id, machineId })).rejects.toThrow(
      ForbiddenError,
    );
  });

  test("waitForUpload: by the database poll, by the signal, and a timeout fails it", async () => {
    f = await setup();
    // No pub/sub: only the poll can see it.
    const polled = await newUpload();
    const waiting = waitForUpload({ db: f.db }, polled.id, 5000, { pollMs: 20 });
    setTimeout(() => {
      void completeUpload({ db: f.db, artifacts: f.artifactDeps }, polled.id, { name: "a.png", bytes: PNG });
    }, 50);
    expect(await waiting).toMatchObject({ status: "done" });

    // A long poll: the signal wakes it.
    const signaled = await newUpload();
    const started = Date.now();
    const woken = waitForUpload({ db: f.db, pubsub: f.pubsub }, signaled.id, 3000, { pollMs: 60_000 });
    setTimeout(() => {
      void completeUpload(uploadDeps(), signaled.id, { name: "b.png", bytes: PNG });
    }, 30);
    expect(await woken).toMatchObject({ status: "done" });
    expect(Date.now() - started).toBeLessThan(2500);

    const never = await newUpload();
    await expect(waitForUpload({ db: f.db }, never.id, 60, { pollMs: 10 })).rejects.toThrow(UploadTimeoutError);
    expect(await uploadRow(never.id)).toMatchObject({ status: "failed" });
  });
});

describe("upload_file", () => {
  /** A connected computer whose runner sends a pushed file to its upload URL as itself, as a real runner does. */
  async function pushingComputer() {
    let machineId = "";
    const computer = await connectedComputer(f, {
      async push(req, bytes, name) {
        await receiveMachineUpload(uploadDeps(), {
          uploadId: req.uploadId,
          machineId,
          name,
          contentType: "",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          body: bytes,
        });
      },
    });
    machineId = computer.paired.machineId;
    return computer;
  }

  test("a file as is, with its data for the reply; versions of uploaded files only", async () => {
    f = await setup({ machines: true, artifactTools: true, reply: () => ({ chunks: ["ok"] }) });
    const { paired, runner } = await pushingComputer();
    await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
    const ctx = await runCtx();
    runner.files.set("out/chart.png", PNG);

    const out = await call(ctx, "upload_file", { path: "out/chart.png", title: "Gráfico" });
    expect(out.isError).toBeFalsy();
    const [a] = await f.db.select().from(schema.artifacts);
    expect(a).toMatchObject({ kind: "file", title: "Gráfico", channelId: f.general.id, untrusted: true });
    expect(out.content).toBe(
      `Uploaded out/chart.png to the Drive as "Gráfico" (file, ${PNG.byteLength} bytes), artifact ${a?.id}, version 1.`,
    );
    expect(out.data).toEqual({ artifact: { id: a?.id, version: 1 } });
    const [up] = await f.db.select().from(schema.artifactUploads);
    expect(up).toMatchObject({ status: "done", path: "out/chart.png", runId: ctx.runId, artifactId: a?.id });
    expect(up?.computer).toBe(`machine:${paired.machineId}`);

    const v2 = await call(ctx, "upload_file", { path: "out/chart.png", artifact_id: a?.id, note: "cores" });
    expect(v2.content).toContain("version 2");

    const read = await call(ctx, "read_artifact", { artifact_id: a?.id });
    expect(read.content).toContain(`File chart.png (image/png, ${PNG.byteLength} bytes`);
    expect(read.content).toContain("untrusted file");

    const table = await call(ctx, "create_artifact", { title: "T", kind: "table", columns: ["a"], rows: [["1"]] });
    const tableId = (table.data as { artifact: { id: string } }).artifact.id;
    const wrong = await call(ctx, "upload_file", { path: "out/chart.png", artifact_id: tableId });
    expect(wrong).toMatchObject({ isError: true });
    expect(wrong.content).toContain("export_file");
    expect((await call(ctx, "upload_file", { path: "out/missing.pdf" })).isError).toBe(true);
    expect((await call(ctx, "upload_file", { path: "../etc/passwd" })).isError).toBe(true);
    // create_artifact can't make a file.
    expect((await call(ctx, "create_artifact", { title: "X", kind: "file" })).isError).toBe(true);
  });

  test("a channel that pushes: the bytes go to the upload URL, never through the tool result", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await pushingComputer();
    const ctx = await runCtx();
    await call(ctx, "write_file", { path: "docs/plan.docx", content: "not really a docx" });
    const out = await call(ctx, "upload_file", { path: "docs/plan.docx" });
    expect(out.isError).toBeFalsy();
    const [up] = await f.db.select().from(schema.artifactUploads);
    const pushes = runner.sent.filter((s) => s.type === "request" && s.op === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      url: `http://localhost:3000/api/machines/uploads/${up?.id}`,
      uploadId: up?.id,
      maxBytes: ARTIFACT_LIMITS.fileBytes,
    });
    expect(up).toMatchObject({ status: "done" });
    const [v] = await f.db.select().from(schema.artifactVersions);
    expect(v).toMatchObject({
      fileName: "plan.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    // No reading or zipping by the server.
    expect(runner.sent.filter((s) => s.type === "request" && (s.op === "exec" || s.op === "read"))).toEqual([]);

    // The machine can't send it: the upload fails and the agent is told.
    const missing = await call(ctx, "upload_file", { path: "docs/nope.pdf" });
    expect(missing).toMatchObject({ isError: true });
    const failed = (await f.db.select().from(schema.artifactUploads)).find((u) => u.path === "docs/nope.pdf");
    expect(failed).toMatchObject({ status: "failed" });
  });

  test("import_file copies an uploaded file's bytes under its original name", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
    const a = await createFileArtifact(f.artifactDeps, person(), f.org.id, {
      title: "Planilha",
      name: "vendas 2026.xlsx",
      bytes: PNG,
    });
    const ctx = await runCtx();
    const out = await call(ctx, "import_file", { artifact_id: a.id });
    expect(out.content).toContain("imports/vendas 2026.xlsx");
    expect(runner.files.get("imports/vendas 2026.xlsx")).toEqual(PNG);
    await call(ctx, "import_file", { artifact_id: a.id, path: "data/v.xlsx" });
    expect(runner.files.get("data/v.xlsx")).toEqual(PNG);
  });
});
