import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, listMessages, postPersonMessage } from "../src";
import { EXPLAIN_FIRST, unexplainedPause } from "../src/executor";
import type { ToolSource } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const tools = [
  { name: "railway_get_logs", scope: "railway:read" },
  { name: "railway_rollback", scope: "railway:write" },
  { name: "ask_user", scope: "" },
];

describe("unexplainedPause", () => {
  test("a card with nothing said, after looking things up", () => {
    expect(unexplainedPause([{ name: "railway_rollback" }], tools, "", true)).toBe(true);
    expect(unexplainedPause([{ name: "ask_user" }], tools, "  ", true)).toBe(true);
    // Only the silence word is nothing said.
    expect(unexplainedPause([{ name: "railway_rollback" }], tools, "NO_REPLY", true)).toBe(true);
  });

  test("not with the findings in the turn, a first-turn request, or no card", () => {
    expect(unexplainedPause([{ name: "railway_rollback" }], tools, "O p95 foi a 4.8s depois do deploy.", true)).toBe(
      false,
    );
    // "faz o deploy" answered at once: nothing was looked up, nothing to tell first.
    expect(unexplainedPause([{ name: "railway_rollback" }], tools, "", false)).toBe(false);
    expect(unexplainedPause([{ name: "railway_get_logs" }], tools, "", true)).toBe(false);
    expect(unexplainedPause([{ name: "unknown_tool" }], tools, "", true)).toBe(false);
  });
});

/** A read tool with something to tell. */
const logs: ToolSource = {
  name: "logs",
  tools: async () => [
    {
      name: "read_logs",
      description: "Read the API logs",
      scope: "",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      describe: () => ({ title: "Read logs" }),
      execute: async () => ({ content: "12:41 deploy 2.14.2 · 12:50 GET /sync p95=4.8s" }),
    },
  ],
};

const asked = { name: "ask_user", input: { question: "Faço o rollback para a 2.14.1?", choices: ["Sim", "Não"] } };

describe("a card asked for with nothing said goes back once for the findings", () => {
  test("after reading, a bare ask_user is returned; the next turn says what it found, then asks", async () => {
    // The last message of each call, as sent (the transcript keeps growing after).
    const requests: string[] = [];
    f = await setup({
      askUser: true,
      toolSources: [logs],
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        requests.push(last);
        if (last.includes("Not run, and nothing was posted")) {
          return { chunks: ["O /sync foi de 410ms a 4.8s depois do deploy 2.14.2 das 12:41."], toolUses: [asked] };
        }
        if (last.includes("p95=4.8s")) return { chunks: [], toolUses: [asked] };
        return { chunks: [], toolUses: [{ name: "read_logs", input: {} }] };
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev o /sync tá lento, o que houve?",
    });
    await drainOutbox(f.db, f.handlers);

    expect(requests.length).toBe(3);
    expect(requests[2]).toContain(EXPLAIN_FIRST);
    // One question, introduced by the findings.
    const questions = await f.db.select().from(schema.agentQuestions);
    expect(questions.length).toBe(1);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("waiting_input");
    const bodies = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).map((m) => m.body);
    const findings = bodies.findIndex((b) => b.includes("4.8s depois do deploy"));
    const card = bodies.findIndex((b) => b === asked.input.question);
    expect(findings).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(findings);
  });

  test("only once: a second bare card goes through", async () => {
    let calls = 0;
    f = await setup({
      askUser: true,
      toolSources: [logs],
      reply: () => {
        calls++;
        return calls === 1
          ? { chunks: [], toolUses: [{ name: "read_logs", input: {} }] }
          : { chunks: [], toolUses: [asked] };
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev o /sync tá lento, o que houve?",
    });
    await drainOutbox(f.db, f.handlers);

    expect(calls).toBe(3);
    expect((await f.db.select().from(schema.agentQuestions)).length).toBe(1);
  });

  test("a direct request asks at once (nothing looked up)", async () => {
    let calls = 0;
    f = await setup({
      askUser: true,
      reply: () => {
        calls++;
        return { chunks: [], toolUses: [asked] };
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz o rollback",
    });
    await drainOutbox(f.db, f.handlers);

    expect(calls).toBe(1);
    expect((await f.db.select().from(schema.agentQuestions)).length).toBe(1);
  });
});
