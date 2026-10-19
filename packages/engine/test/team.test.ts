import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import { addChannelMember, createAgent, drainOutbox, postPersonMessage, teamPrompt } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

const addAgent = (name: string, handle: string, role: string, instructions = "") =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role, instructions, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

test("a big team is only a count with a pointer to find_agent", () => {
  const team = Array.from({ length: 20 }, (_, i) => ({
    id: `a${i}`,
    name: `A${i}`,
    handle: `a${i}`,
    role: "",
    instructions: "",
    ownerUserId: null,
    audienceMode: "everyone" as const,
    audienceUserIds: [],
  }));
  const text = teamPrompt(team, "a0", null, new Set());
  expect(text).toContain("19 other agents work in this organization.");
  expect(text).not.toContain("@a1");
});

test("an agent knows the org's other agents it can work with, even outside its channels (D54)", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  await addAgent("Infra", "infra", "Infrastructure");
  const qa = await addAgent("QA", "qa", "Testes");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
  // Nobody can talk to this one: it never shows up.
  const hidden = await addAgent("Secret", "secret", "Finance");
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: null })
    .where(eq(schema.agents.id, hidden.id));

  await post("@dev oi");
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(requests[0]?.system ?? []);
  expect(prompt).toContain("# Your team\nOther agents in this organization: @infra (Infrastructure).");
  expect(prompt).toContain("`find_agent`");
  expect(prompt).not.toContain("@secret");
  // QA is a channel member: described in "Where you are", not repeated in the team.
  expect(prompt).not.toMatch(/Other agents in this organization:[^\n]*@qa/);
});

test("find_agent searches by what agents do and shows what they can do", async () => {
  const results: string[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) {
        results.push(last);
        return { chunks: ["done"] };
      }
      return { chunks: [], toolUses: [{ name: "find_agent", input: { query: "deploy de staging" } }] };
    },
  });
  await addAgent("Infra", "infra", "Infrastructure", "Cuida dos servidores e do deploy no Railway.");
  await addAgent("Design", "design", "Designer", "Faz telas e protótipos.");

  await post("@dev quem faz deploy?");
  await drainOutbox(f.db, f.handlers);

  const out = results[0] ?? "";
  expect(out).toContain("@infra: Infra, Infrastructure");
  expect(out).toContain("Files (Drive)");
  expect(out).toContain("Responsible person:");
  expect(out).not.toContain("@design");
  expect(out).not.toContain("@dev:");
});
