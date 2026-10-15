import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  createArtifact,
  createChannel,
  drainOutbox,
  listArtifacts,
  listMessages,
  openDm,
  postPersonMessage,
  requesterSharedChannels,
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

describe("work done in other conversations", () => {
  test("a report made in the DM shows up in #general for the same person, and share_artifact brings it", async () => {
    let originalId = "";
    const prompts: Record<string, string> = {};
    f = await setup({
      artifactTools: true,
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        if (last.includes("monta um relatorio")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "create_artifact",
                input: { title: "Relatório semanal de visitas", kind: "document", markdown: "# Visitas\n120" },
              },
            ],
          };
        }
        // Bob's turn also holds Ana's earlier message (consecutive user messages merge): match his first.
        if (last.includes("pdf da ana")) {
          prompts.bob = systemText(req.system ?? "");
          return { chunks: [], toolUses: [{ name: "share_artifact", input: { artifact_id: originalId } }] };
        }
        if (last.includes("aquele pdf")) {
          prompts.ana = systemText(req.system ?? "");
          return { chunks: [], toolUses: [{ name: "share_artifact", input: { artifact_id: originalId } }] };
        }
        return { chunks: ["ok"] };
      },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "pega as visitas e monta um relatorio em pdf" });
    await drainOutbox(f.db, f.handlers);
    const [original] = await f.db.select().from(schema.artifacts);
    expect(original).toMatchObject({ channelId: dm.id, title: "Relatório semanal de visitas" });
    originalId = original?.id ?? "";

    // Same person, in #general: the block shows the DM work, and the file comes over as a copy here.
    const ask = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
      body: "@dev manda aqui aquele pdf que tu gerou pra mim no privado",
    });
    await drainOutbox(f.db, f.handlers);
    expect(prompts.ana).toContain("# Seu trabalho recente com ana em outras conversas");
    expect(prompts.ana).toContain('- DM com ana, há 0 min: create_artifact → Saved "Relatório semanal de visitas"');
    expect(prompts.ana).toContain(originalId);
    expect(prompts.ana).toContain("No privado");
    const shared = (await toolResults()).find((r) => r.name === "share_artifact");
    expect(shared).toMatchObject({ isError: false });
    expect(shared?.content).toContain("trazendo do nosso privado");
    const copies = (await f.db.select().from(schema.artifacts)).filter((a) => a.channelId === f.general.id);
    expect(copies.map((a) => a.title)).toEqual(["Relatório semanal de visitas"]);
    const reply = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id })).at(-1);
    expect(reply?.meta.artifacts).toEqual([{ id: copies[0]?.id, version: 1 }]);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.find((a) => a.action === "artifact.shared")).toMatchObject({
      actorType: "agent",
      targetId: originalId,
      details: { fromChannelId: dm.id, toChannelId: f.general.id, copyId: copies[0]?.id },
    });

    // Someone who isn't in that DM: nothing from it in the prompt, and sharing it is refused.
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    await postPersonMessage(deps, bob.id, f.org.id, f.general.id, { body: "@dev me manda o pdf da ana" });
    await drainOutbox(f.db, f.handlers);
    expect(prompts.bob).not.toContain("DM com");
    expect(prompts.bob).not.toContain(originalId);
    const refused = (await toolResults()).filter((r) => r.name === "share_artifact").at(-1);
    expect(refused).toMatchObject({ isError: true });
    expect(refused?.content).toContain("not found");
    expect((await f.db.select().from(schema.artifacts)).length).toBe(2);
  });
});

describe("list_artifacts for agents", () => {
  test("filters: mine, requester's conversations, query, kind, since; with origin and creator", async () => {
    f = await setup({ artifactTools: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    // bob's private channel (ana is not in it), with the agent.
    const secret = await createChannel(f.db, bob.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const inDm = { type: "agent" as const, agentId: f.agent.id, channelId: dm.id };
    const inSecret = { type: "agent" as const, agentId: f.agent.id, channelId: secret.id };
    const inGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const report = await createArtifact(f.artifactDeps, inDm, f.org.id, {
      title: "Relatório de visitas",
      content: { kind: "document", markdown: "x" },
    });
    const plan = await createArtifact(f.artifactDeps, inSecret, f.org.id, {
      title: "Plano",
      content: { kind: "table", columns: ["a"], rows: [["1"]] },
    });
    const manual = await createArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Manual",
      content: { kind: "document", markdown: "y" },
    });

    expect((await requesterSharedChannels(f.db, f.org.id, f.agent.id, f.owner.id)).sort()).toEqual(
      [f.general.id, dm.id].sort(),
    );
    const ids = (list: { id: string }[]) => list.map((a) => a.id).sort();
    // From #general on ana's behalf: her DM with the agent too, never the private channel she isn't in.
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: f.owner.id }))).toEqual(
      [report.id, manual.id].sort(),
    );
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id))).toEqual([manual.id]);
    // On bob's behalf: his private channel with the agent, not ana's DM.
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: bob.id }))).toEqual(
      [plan.id, manual.id].sort(),
    );
    expect(
      ids(
        await listArtifacts(f.db, inGeneral, f.org.id, {
          requesterUserId: f.owner.id,
          author: { type: "agent", id: f.agent.id },
        }),
      ),
    ).toEqual([report.id]);
    expect(ids(await listArtifacts(f.db, inSecret, f.org.id, { kind: "table" }))).toEqual([plan.id]);
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: f.owner.id, q: "visitas" }))).toEqual([
      report.id,
    ]);
    const later = new Date(Date.now() + 60_000);
    expect(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: f.owner.id, since: later })).toEqual([]);

    // Through the tool: origin and creator on every line.
    const tool = (
      await f.tools?.list({
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: crypto.randomUUID(),
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
      })
    )?.find((t) => t.name === "list_artifacts");
    expect(tool).toBeDefined();
    const out = await tool?.execute(
      { createdByMe: true, visibleToRequester: false },
      {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: crypto.randomUUID(),
        channelId: dm.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
      },
    );
    expect(out?.content).toContain(`${report.id} "Relatório de visitas" (document, v1,`);
    expect(out?.content).toContain("origem: aqui; criado por @dev");
  });
});
