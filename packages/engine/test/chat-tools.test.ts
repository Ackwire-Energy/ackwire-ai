import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { addChannelMember, createChannel, drainOutbox, openDm, postPersonMessage, setChannelOverride } from "../src";
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
  const files = (posted?.meta as { artifacts?: string[] } | undefined)?.artifacts ?? [];
  expect(files).toHaveLength(1);
  // From the DM: a copy in #general, so the people there can open it; the original stays in the DM.
  const [copy] = await f.db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, files[0] as string));
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

test("send_dm: the agent writes to a person in its DM with them, they're notified; several matches ask which one", async () => {
  const person = "thay";
  f = await setup({
    chatTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("avisa")) {
        return {
          chunks: [],
          toolUses: [{ name: "send_dm", input: { person, text: "Oi Thay! O Walter pediu para te avisar do e-mail." } }],
        };
      }
      return { chunks: ["ok"] };
    },
  });
  const thay = await addMember(f.db, f.org.id, "member", "Tháy Lima");
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev avisa a thay desse email na dm" });
  await drainOutbox(f.db, f.handlers);
  expect((await toolResults()).find((r) => r.name === "send_dm")).toMatchObject({ isError: false });

  // The DM between Thay and the agent, with the message from the agent, and a notification for her.
  const dm = (await f.db.select().from(schema.channels)).find((c) => c.kind === "dm");
  const members = await f.db
    .select()
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, dm?.id ?? ""));
  expect(members.map((m) => m.userId ?? m.agentId).sort()).toEqual([thay.id, f.agent.id].sort());
  const [sent] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.channelId, dm?.id ?? ""));
  expect(sent).toMatchObject({
    authorType: "agent",
    authorAgentId: f.agent.id,
    body: "Oi Thay! O Walter pediu para te avisar do e-mail.",
  });
  expect(sent?.meta.agentDm).toMatchObject({ requesterUserId: f.owner.id });
  const notes = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, thay.id), eq(schema.notifications.kind, "dm")));
  expect(notes).toHaveLength(1);

  // Two people whose first name is the same: the agent is told to ask which one.
  await addMember(f.db, f.org.id, "member", "Thay Souza");
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev avisa a thay de novo" });
  await drainOutbox(f.db, f.handlers);
  const results = (await toolResults()).filter((r) => r.name === "send_dm");
  expect(results.at(-1)).toMatchObject({ isError: true });
  expect(results.at(-1)?.content).toContain("Several people match");
});
