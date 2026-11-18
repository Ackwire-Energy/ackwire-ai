import { afterEach, expect, test } from "bun:test";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  createAgent,
  createChannel,
  drainOutbox,
  invokeToolForRun,
  openDm,
  postPersonMessage,
  setChannelOverride,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const toolResults = async () =>
  (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { name: string; content: string; isError: boolean });

test("post_message: from a DM to #general with the file (as a copy); only channels the person is in", async () => {
  let fileId = "";
  let target = "#general";
  f = await setup({
    artifactTools: true,
    chatTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("monta o carrossel")) {
        return {
          chunks: [],
          toolUses: [
            { name: "create_artifact", input: { title: "Carrossel Miami", kind: "document", markdown: "# 6 slides" } },
          ],
        };
      }
      if (last.includes("manda no canal")) {
        return {
          chunks: [],
          toolUses: [
            {
              name: "post_message",
              input: { channel: target, text: "Carrossel de Miami pronto", artifact_ids: [fileId] },
            },
          ],
        };
      }
      return { chunks: ["ok"] };
    },
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "monta o carrossel de miami" });
  await drainOutbox(f.db, f.handlers);
  const [original] = await f.db.select().from(schema.artifacts);
  fileId = original?.id ?? "";
  expect(original?.channelId).toBe(dm.id);

  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "boa, manda no canal geral" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).find((r) => r.name === "post_message")).toMatchObject({ isError: false });
  const [posted] = await f.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, f.general.id), eq(schema.messages.authorAgentId, f.agent.id)));
  expect(posted?.body).toBe("Carrossel de Miami pronto");
  type FileRef = { id: string; version: number; title: string };
  const files = (posted?.meta as { artifacts?: FileRef[] } | undefined)?.artifacts;
  // The file card's shape (`{ id, version, title }`), so the apps show it and the agent reads it by name.
  expect(files).toEqual([{ id: expect.any(String), version: 1, title: "Carrossel Miami" }]);
  // From the DM: a copy in #general, so the people there can open it; the original stays in the DM.
  const [copy] = await f.db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, files?.[0]?.id ?? ""));
  expect(copy).toMatchObject({ channelId: f.general.id, title: "Carrossel Miami" });
  expect(copy?.id).not.toBe(fileId);
  const [audit] = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "message.posted_elsewhere"));
  expect(audit?.details).toMatchObject({ fromChannelId: dm.id, toChannelId: f.general.id });

  // A private channel without the agent: refused, saying how to fix it.
  await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
  target = "diretoria";
  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "manda no canal diretoria" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).filter((r) => r.name === "post_message").at(-1)).toMatchObject({
    isError: true,
    content: expect.stringContaining("You are not in #diretoria"),
  });

  // A channel the person isn't in: as if it didn't exist.
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  await createChannel(f.db, bia.id, f.org.id, { name: "segredo", visibility: "private" });
  target = "#segredo";
  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "manda no canal segredo" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).filter((r) => r.name === "post_message").at(-1)).toMatchObject({
    isError: true,
    content: "No channel #segredo that the person who asked can post in.",
  });

  // In #general but its exceptions stop them sending there (ADR 0134): the agent doesn't send it for them.
  const leo = await addMember(f.db, f.org.id, "member", "leo");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: leo.id });
  await setChannelOverride(f.db, f.owner.id, f.org.id, f.general.id, {
    target: { type: "person", id: leo.id },
    allow: [],
    deny: ["post"],
  });
  const leoDm = await openDm(f.db, leo.id, f.org.id, { agentId: f.agent.id });
  target = "#general";
  await postPersonMessage(deps, leo.id, f.org.id, leoDm.id, { body: "boa, manda no canal geral" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).filter((r) => r.name === "post_message").at(-1)).toMatchObject({
    isError: true,
    content: "No channel #general that the person who asked can post in.",
  });
});

test("post_message from a consulted agent: never where an agent that asked it answers", async () => {
  f = await setup({
    chatTools: true,
    askAgent: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Pedi."] };
      if (last.includes("pede pro nino")) {
        return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@nino", question: "Faz as fotos" } }] };
      }
      return { chunks: ["ok"] };
    },
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const say = async (body: string, channelId: string, threadId?: string) => {
    const message = await postPersonMessage(deps, f.owner.id, f.org.id, channelId, {
      body,
      ...(threadId ? { threadId } : {}),
    });
    await drainOutbox(f.db, f.handlers);
    return message;
  };
  const nino = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Nino", handle: "nino", role: "Fotos", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const fotos = await createChannel(f.db, f.owner.id, f.org.id, { name: "fotos" });
  await addChannelMember(f.db, f.owner.id, f.org.id, fotos.id, { agentId: f.agent.id });
  const avisos = await createChannel(f.db, f.owner.id, f.org.id, { name: "avisos" });

  // The person asks @dev inside a thread of #general, and @dev asks Nino in the two agents' conversation.
  const root = await say("@dev capas da semana", f.general.id);
  const asked = await say("@dev pede pro nino as fotos", f.general.id, root.id);
  const [asker] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  expect(asker?.threadRootId).toBe(root.id);
  const [consulted] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, nino.id));
  if (!consulted) throw new Error("the consultation started no run");
  expect(consulted.channelId).not.toBe(f.general.id);
  const post = async (channel: string) =>
    (
      await invokeToolForRun(
        { ...deps, tools: f.tools },
        { orgId: f.org.id, agentId: nino.id, runId: consulted.id, machineId: "" },
        { id: crypto.randomUUID(), name: "post_message", input: { channel, text: "Fotos prontas" } },
      )
    ).result;
  const postsIn = (channelId: string) =>
    f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, channelId), eq(schema.messages.authorAgentId, nino.id)));

  // @dev answers in that thread with what Nino gives it: a post of Nino's would land at the channel's top level.
  const refused = await post("general");
  expect(refused.isError).toBe(true);
  expect(refused.content).toContain("#general is where the agent that asked you answers");
  expect(await postsIn(f.general.id)).toHaveLength(0);

  // A second request, from #fotos, as when it joins the run still at work (`startOrJoinRun`): that run answers
  // both, and posts in neither place.
  await say("@dev pede pro nino as fotos", fotos.id);
  const requests = await f.db.select().from(schema.agentConsultations).orderBy(schema.agentConsultations.createdAt);
  expect(requests).toHaveLength(2);
  await f.db
    .update(schema.agentConsultations)
    .set({ targetRunId: consulted.id })
    .where(eq(schema.agentConsultations.id, requests[1]?.id as string));
  expect((await post("general")).isError).toBe(true);
  expect((await post("fotos")).isError).toBe(true);
  expect(await postsIn(f.general.id)).toHaveLength(0);
  expect(await postsIn(fotos.id)).toHaveLength(0);
  // Any other channel the person is in is still a place to post.
  expect((await post("avisos")).isError).toBeFalsy();
  expect(await postsIn(avisos.id)).toHaveLength(1);

  // News nobody carries back (a heads-up) is no answer for someone else to deliver: the post goes through.
  await f.db
    .update(schema.messages)
    .set({ meta: sql`${schema.messages.meta} || '{"agentNote":{"headsUp":true}}'::jsonb` })
    .where(
      inArray(
        schema.messages.id,
        requests.map((r) => r.messageId),
      ),
    );
  expect((await post("general")).isError).toBeFalsy();
  expect(await postsIn(f.general.id)).toHaveLength(1);
});

test("send_dm: the agent writes to a person in its DM with them, they're notified; several matches ask which one", async () => {
  const person = "joao";
  f = await setup({
    chatTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("avisa")) {
        return {
          chunks: [],
          toolUses: [{ name: "send_dm", input: { person, text: "Oi Joao! O Leo pediu para te avisar do e-mail." } }],
        };
      }
      return { chunks: ["ok"] };
    },
  });
  const joao = await addMember(f.db, f.org.id, "member", "João Lima");
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev avisa o joao desse email na dm" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).find((r) => r.name === "send_dm")).toMatchObject({ isError: false });

  // The DM between Joao and the agent, with the message from the agent, and a notification for him.
  const dm = (await f.db.select().from(schema.channels)).find((c) => c.kind === "dm");
  const members = await f.db
    .select()
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, dm?.id ?? ""));
  expect(members.map((m) => m.userId ?? m.agentId).sort()).toEqual([joao.id, f.agent.id].sort());
  const [sent] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.channelId, dm?.id ?? ""));
  expect(sent).toMatchObject({
    authorType: "agent",
    authorAgentId: f.agent.id,
    body: "Oi Joao! O Leo pediu para te avisar do e-mail.",
  });
  expect(sent?.meta.agentDm).not.toHaveProperty("requesterUserId");
  const notes = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, joao.id), eq(schema.notifications.kind, "dm")));
  expect(notes).toHaveLength(1);

  // Two people whose first name is the same: the agent is told to ask which one.
  await addMember(f.db, f.org.id, "member", "Joao Souza");
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev avisa o joao de novo" });
  await drainOutbox(f.db, f.handlers);
  const results = (await toolResults()).filter((r) => r.name === "send_dm");
  expect(results.at(-1)).toMatchObject({ isError: true });
  expect(results.at(-1)?.content).toContain("Several people match");
});

test("send_dm to a blocked account or one waiting for its deletion: nobody by that name, nothing sent", async () => {
  f = await setup({
    chatTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("avisa"))
        return { chunks: [], toolUses: [{ name: "send_dm", input: { person: "joao", text: "Oi!" } }] };
      return { chunks: ["ok"] };
    },
  });
  const joao = await addMember(f.db, f.org.id, "member", "João Lima");
  const deps = { db: f.db, pubsub: f.pubsub };
  for (const closed of [
    { blockedAt: new Date() },
    { blockedAt: null, deletionDueAt: new Date(Date.now() + 86_400_000) },
  ]) {
    await f.db.update(schema.users).set(closed).where(eq(schema.users.id, joao.id));
    await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev avisa o joao na dm" });
    await drainOutbox(f.db, f.handlers);
    expect((await toolResults()).filter((r) => r.name === "send_dm").at(-1)).toMatchObject({
      isError: true,
      content: 'No one called "joao" in this organization.',
    });
  }
  expect((await f.db.select().from(schema.channels)).some((c) => c.kind === "dm")).toBe(false);
});

test("send_dm with a file: the person gets the file itself (a copy from the asker's DM), not only its name; a file the asker can't see is refused", async () => {
  let fileId = "";
  f = await setup({
    artifactTools: true,
    chatTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("monta o roteiro")) {
        return {
          chunks: [],
          toolUses: [
            { name: "create_artifact", input: { title: "Roteiro do video", kind: "document", markdown: "# Cena 1" } },
          ],
        };
      }
      if (last.includes("manda pra bia")) {
        // Files only: the text is optional when there are files.
        return { chunks: [], toolUses: [{ name: "send_dm", input: { person: "bia", artifact_ids: [fileId] } }] };
      }
      return { chunks: ["ok"] };
    },
  });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const deps = { db: f.db, pubsub: f.pubsub };
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "monta o roteiro do video" });
  await drainOutbox(f.db, f.handlers);
  const [original] = await f.db.select().from(schema.artifacts);
  fileId = original?.id ?? "";
  expect(original?.channelId).toBe(dm.id);

  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "manda pra bia na dm" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).find((r) => r.name === "send_dm")).toMatchObject({
    isError: false,
    content: expect.stringContaining("with 1 file(s)"),
  });
  const sentDms = async () =>
    (await f.db.select().from(schema.messages)).filter((m) => (m.meta as { agentDm?: unknown }).agentDm);
  const [sent] = await sentDms();
  const biaDm = sent?.channelId ?? "";
  const members = await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, biaDm));
  expect(members.map((m) => m.userId ?? m.agentId).sort()).toEqual([bia.id, f.agent.id].sort());
  expect(sent).toMatchObject({ authorType: "agent", authorAgentId: f.agent.id });
  // `meta.artifacts` holds ids, or entries with an id: read either.
  const files = (sent?.meta as { artifacts?: unknown[] } | undefined)?.artifacts ?? [];
  expect(files).toHaveLength(1);
  const first = files[0];
  const copyId = typeof first === "string" ? first : (first as { id: string }).id;
  // From the asker's DM: a copy in Bia's DM with the agent, so she can open it; the original stays where it was.
  const [copy] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, copyId));
  expect(copy).toMatchObject({ channelId: biaDm, title: "Roteiro do video" });
  expect(copy?.id).not.toBe(fileId);
  const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "message.sent_dm"));
  expect(audit?.details).toMatchObject({ toUserId: bia.id, fromChannelId: dm.id, artifactIds: [copyId] });
  const notes = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, bia.id), eq(schema.notifications.kind, "dm")));
  expect(notes).toHaveLength(1);

  // A file from a DM the asker isn't in: as if it didn't exist, and nothing is sent.
  const leo = await addMember(f.db, f.org.id, "member", "leo");
  const leoDm = await openDm(f.db, leo.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage(deps, leo.id, f.org.id, leoDm.id, { body: "monta o roteiro do video" });
  await drainOutbox(f.db, f.handlers);
  const [leoFile] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.channelId, leoDm.id));
  fileId = leoFile?.id ?? "";
  expect(fileId).not.toBe("");
  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "manda pra bia na dm esse outro" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).filter((r) => r.name === "send_dm").at(-1)).toMatchObject({
    isError: true,
    content: expect.stringContaining("not found"),
  });
  expect(await sentDms()).toHaveLength(1);
});
