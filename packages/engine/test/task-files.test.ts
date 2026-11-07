import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createChannel,
  createFileArtifact,
  createIssue,
  createIssueToolSource,
  getArtifact,
  getIssue,
  idRef,
  insertMessage,
  issueFromMessage,
  linkRunActions,
  listIssueActivity,
  openDm,
  postPersonMessage,
  type ToolContext,
  undoAgentAction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const upload = (channelId: string, name = "print.png", userId = f.owner.id) =>
  createFileArtifact(f.artifactDeps, person(userId), f.org.id, {
    title: name,
    name,
    bytes: PNG,
    contentType: "image/png",
    channelId,
  });

/**
 * A person's message with files and the agent's run on it (the one a DM starts by itself, else a new one): the tools'
 * context (they act for that person).
 */
async function askWith(channelId: string, body: string, files: string[], userId = f.owner.id): Promise<ToolContext> {
  const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, channelId, {
    body,
    attachments: files,
  });
  const [started] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.triggerMessageId, m.id), eq(schema.agentRuns.agentId, f.agent.id)));
  const [run] = started
    ? [started]
    : await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId,
          threadRootId: m.id,
          triggerMessageId: m.id,
          trigger: "mention",
          hop: 1,
          status: "running",
        })
        .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: m.id,
  };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const tool = (await createIssueToolSource(f.artifactDeps).tools(ctx)).find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool.execute(input, ctx);
}

const task = (number: number) => getIssue(f.db, person(f.owner.id), f.org.id, { number });
const receipts = () => f.db.select().from(schema.agentActions);

describe("a task an agent makes or changes takes the files it's about", () => {
  test("made from a message with a print, the print is attached, under its description and on the receipt", async () => {
    f = await setup();
    const print = await upload(f.general.id);
    const ctx = await askWith(f.general.id, "coloca no backlog: um widget para usar durante a navegação", [print.id]);
    const out = await call(ctx, "create_issue", { title: "Widget flutuante", description: "Ideia de um widget." });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('Attached "print.png"');
    expect(out.content).toContain("never its id");
    const made = await task(1);
    // #general is open to the workspace, like the task: the same file.
    expect(made.artifacts.map((a) => [a.id, a.title])).toEqual([[print.id, "print.png"]]);
    const created = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, made.id)).find(
      (a) => a.event === "created",
    );
    expect(created?.attachments).toEqual([{ id: print.id, title: "print.png" }]);
    const [receipt] = await receipts();
    expect(receipt?.kind).toBe("issue.created");
    expect(receipt?.params).toMatchObject({ number: 1, files: ["print.png"] });
  });

  test("made in a DM, the DM's print goes as it is (the task is the DM's); files: [] takes none", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const print = await upload(dm.id);
    const ctx = await askWith(dm.id, "anota numa tarefa com esse print", [print.id]);
    await call(ctx, "create_issue", { title: "Com o print" });
    expect((await task(1)).artifacts.map((a) => a.id)).toEqual([print.id]);
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, print.id)).id).toBe(print.id);
    await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, print.id)).rejects.toThrow();
    await call(ctx, "create_issue", { title: "Sem anexo", files: [] });
    expect((await task(2)).artifacts).toEqual([]);
  });

  test("a task for the whole workspace made in a DM takes no file of the DM, and the agent hears what to say", async () => {
    f = await setup();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const print = await upload(dm.id);
    const ctx = await askWith(dm.id, "cria uma tarefa para todo mundo com esse print", [print.id]);
    const out = await call(ctx, "create_issue", { title: "Para todos", visible_to: "everyone" });
    expect(out.content).toContain("Not attached");
    expect(out.content).toContain("Anexos");
    const made = await task(1);
    expect(made.audience.mode).toBe("everyone");
    expect(made.artifacts).toEqual([]);
  });

  test("a file from the asker's DM put on a task of the workspace goes as a copy everyone there opens", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await createIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, { title: "Widget" });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const print = await upload(dm.id);
    const ctx = await askWith(f.general.id, "põe o print da nossa DM na #1", []);
    const out = await call(ctx, "update_issue", { issue: "#1", files: [print.id] });
    expect(out.content).toContain('Attached "print.png"');
    const [copy] = (await task(1)).artifacts;
    expect(copy?.title).toBe("print.png");
    expect(copy?.id).not.toBe(print.id);
    const opened = await getArtifact(f.artifactDeps, person(bia.id), f.org.id, copy?.id ?? "");
    const [row] = await f.db
      .select({ conversation: schema.issues.conversationChannelId })
      .from(schema.issues)
      .where(eq(schema.issues.number, 1));
    expect(opened.channelId).toBe(row?.conversation ?? "none");
    await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, print.id)).rejects.toThrow();
  });

  test("a file the person who asked can't see doesn't go, and the agent hears why", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const secret = await createChannel(f.db, bia.id, f.org.id, { name: "secreto", visibility: "private" });
    const hidden = await upload(secret.id, "segredo.png", bia.id);
    const ctx = await askWith(f.general.id, "cria a tarefa", []);
    const out = await call(ctx, "create_issue", { title: "Tarefa", files: [hidden.id] });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Not attached");
    expect((await task(1)).artifacts).toEqual([]);
  });

  test("update_issue attaches it; Desfazer takes it off, named in the history", async () => {
    f = await setup();
    await createIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, { title: "Widget" });
    const print = await upload(f.general.id);
    const ctx = await askWith(f.general.id, "põe esse print na #1", [print.id]);
    const out = await call(ctx, "update_issue", { issue: "#1", files: [print.id] });
    expect(out.content).toContain('Attached "print.png"');
    expect((await task(1)).artifacts.map((a) => a.id)).toEqual([print.id]);
    const [receipt] = await receipts();
    expect(receipt?.kind).toBe("issue.updated");
    expect(receipt?.params).toMatchObject({ fields: ["files"], files: ["print.png"] });
    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: ctx.runId, hop: 0 },
      body: "Pronto.",
    });
    await linkRunActions(f.db, f.org.id, ctx.runId, reply.id);
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const after = await task(1);
    expect(after.artifacts).toEqual([]);
    const history = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, after.id)).filter((a) =>
      a.event?.startsWith("artifact_"),
    );
    expect(history.map((a) => [a.textCode, a.textParams?.names])).toEqual([
      ["files_attached", "print.png"],
      ["files_removed", "print.png"],
    ]);
  });

  test("comment_issue carries files to the task's conversation and its Anexos", async () => {
    f = await setup();
    await createIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, { title: "Relatório" });
    const report = await upload(f.general.id, "relatorio.pdf");
    const ctx = await askWith(f.general.id, "comenta na #1 com o relatório", []);
    const out = await call(ctx, "comment_issue", { issue: "#1", text: "Segue o relatório.", files: [report.id] });
    expect(out.content).toContain('Attached "relatorio.pdf"');
    expect((await task(1)).artifacts.map((a) => a.id)).toEqual([report.id]);
  });

  test("Transformar em tarefa keeps the message's files", async () => {
    f = await setup();
    const print = await upload(f.general.id);
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "o login quebrou depois do deploy",
      attachments: [print.id],
    });
    const made = await issueFromMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, m.id);
    expect(made.artifacts.map((a) => a.id)).toEqual([print.id]);
  });
});

describe("an internal id written in a text names what it is, for who may see it", () => {
  test("a file, a task, a message and a run's reply; anything else isn't found", async () => {
    f = await setup();
    const print = await upload(f.general.id);
    const made = await createIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, { title: "Widget" });
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "o widget",
    });
    const ctx = await askWith(f.general.id, "responde", []);
    await f.db.update(schema.agentRuns).set({ replyMessageId: m.id }).where(eq(schema.agentRuns.id, ctx.runId));
    const ref = (id: string, userId = f.owner.id) => idRef(f.db, userId, f.org.id, id);
    expect(await ref(print.id)).toEqual({
      kind: "file",
      id: print.id,
      title: "print.png",
      artifactKind: "file",
      fileName: "print.png",
      contentType: "image/png",
    });
    expect(await ref(made.id)).toEqual({ kind: "task", id: made.id, number: 1, title: "Widget" });
    expect(await ref(m.id)).toMatchObject({ kind: "message", message: { id: m.id, channelId: f.general.id } });
    expect(await ref(ctx.runId)).toMatchObject({ kind: "message", message: { id: m.id } });
    // A background work names its card.
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        anchorMessageId: m.id,
        ownThread: true,
        title: "Widget",
        issueId: made.id,
        status: "live",
        how: "agent",
        lastUpdateAt: new Date(),
      })
      .returning();
    expect(await ref(work?.id ?? "")).toMatchObject({ kind: "task", number: 1 });
    await expect(ref(crypto.randomUUID())).rejects.toThrow("Nothing here has this id");
    await expect(ref("not-an-id")).rejects.toThrow("Nothing here has this id");
  });

  test("a file in a DM someone isn't in names nothing for them", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const print = await upload(dm.id);
    await expect(idRef(f.db, bia.id, f.org.id, print.id)).rejects.toThrow("Nothing here has this id");
    expect((await idRef(f.db, f.owner.id, f.org.id, print.id)).kind).toBe("file");
  });
});
