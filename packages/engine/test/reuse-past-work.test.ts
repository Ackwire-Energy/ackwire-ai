import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import { addChannelMember, createChannel, drainOutbox, postPersonMessage, type ToolSource } from "../src";
import { setup as baseSetup, type Fixture } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const MODELS_URL = "https://api.typesafe.example/v1/models";

/** A stand-in for the agent's computer: a request to an address, which works only at the right one. */
const fetchSource: ToolSource = {
  name: "fetch",
  tools: async () => [
    {
      name: "fetch_url",
      description: "Fetch an address with a secret from your computer.",
      scope: "context:read",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, secret: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async (input) =>
        input.url === MODELS_URL ? { content: '["ts-small","ts-large"]' } : { content: "404 Not Found", isError: true },
    },
  ],
};

const isReflect = (system: string) => system.includes("shared memory");

describe("agents reuse past work", () => {
  test("a figured-out task is saved as a how-to; a second similar request finds it, the earlier steps and the held secret's name", async () => {
    let step = 0;
    const secondSystems: string[] = [];
    f = await baseSetup({
      contextTools: true,
      toolSources: [fetchSource],
      reply: (req) => {
        const system = systemText(req.system);
        if (isReflect(system)) return { chunks: [JSON.stringify({ summary: "", items: [], entities: [] })] };
        const all = JSON.stringify(req.messages);
        if (all.includes("list the TypeSafe models again")) {
          secondSystems.push(system);
          return all.includes("your earlier step")
            ? { chunks: ["ts-small, ts-large"] }
            : { chunks: [], toolUses: [{ name: "search_context", input: { query: "typesafe models" } }] };
        }
        step++;
        const calls: Record<number, { name: string; input: Record<string, unknown> }> = {
          1: { name: "fetch_url", input: { url: "https://typesafe.example/api/models", secret: "TYPESAFE_API_KEY" } },
          2: { name: "fetch_url", input: { url: MODELS_URL, secret: "TYPESAFE_API_KEY" } },
          3: {
            name: "save_how_to",
            input: {
              title: "List the TypeSafe models",
              how: `GET ${MODELS_URL} with the TYPESAFE_API_KEY secret as a bearer token; script scripts/typesafe-models.sh`,
            },
          },
        };
        const call = calls[step];
        return call ? { chunks: [], toolUses: [call] } : { chunks: ["ts-small, ts-large"] };
      },
    });
    const post = (body: string, channelId = f.general.id) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });

    await post("@dev pull the models from the TypeSafe API");
    await drainOutbox(f.db, f.handlers);
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { name: string; isError: boolean });
    expect(results.map((r) => [r.name, r.isError])).toEqual([
      ["fetch_url", true],
      ["fetch_url", false],
      ["save_how_to", false],
    ]);
    const [howTo, ...others] = await f.db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.agentId, f.agent.id));
    expect(others).toEqual([]);
    expect([howTo?.kind, howTo?.scopeType, howTo?.channelIds, howTo?.createdByKind, howTo?.title]).toEqual([
      "note",
      "agent",
      [],
      "agent",
      "List the TypeSafe models",
    ]);

    // The person gave the key through request_secret in that run; a removed one and another agent's don't count.
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const secret = (name: string, extra: Partial<typeof schema.secretRequests.$inferInsert> = {}) => ({
      orgId: f.org.id,
      runId: run.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      toolUseId: `tu_${name}`,
      requestedForUserId: f.owner.id,
      name,
      purpose: "TypeSafe API",
      targetKind: "env" as const,
      publicKey: "fake-public-key",
      expiresAt: new Date(Date.now() + 60_000),
      status: "delivered" as const,
      deliveredAt: new Date(),
      ...extra,
    });
    await f.db
      .insert(schema.secretRequests)
      .values([
        secret("TYPESAFE_API_KEY"),
        secret("OLD_TOKEN", { removedAt: new Date() }),
        secret("NPM_TOKEN", { targetKind: "file", targetPath: ".npmrc" }),
      ]);

    // Elsewhere, later: another channel the agent is in.
    const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops", visibility: "public" });
    await addChannelMember(f.db, f.owner.id, f.org.id, ops.id, { agentId: f.agent.id });
    await post("@dev list the TypeSafe models again", ops.id);
    await drainOutbox(f.db, f.handlers);

    const first = secondSystems[0] ?? "";
    // Its memory carries the how-to; its computer's secrets are named, never their values.
    expect(first).toContain(`List the TypeSafe models: GET ${MODELS_URL}`);
    expect(first).toContain("# Secrets on your computer");
    expect(first).toContain("- TYPESAFE_API_KEY: an environment variable in your commands");
    expect(first).toContain("- NPM_TOKEN: the file .npmrc");
    expect(first).not.toContain("OLD_TOKEN");
    // The prompt says to look for past work first and to save what took figuring out.
    expect(first).toContain("Before a task, look for how it was done before");
    expect(first).toContain("save how you did it with `save_how_to`");

    // search_context finds the earlier calls themselves (in #general, searched from #ops), with how each ended.
    const search = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result" && (s.data as { name: string }).name === "search_context")
      .map((s) => (s.data as { content: string }).content);
    expect(search).toHaveLength(1);
    const lines = (search[0] ?? "").split("\n").filter((l) => l.startsWith("[your earlier step]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`fetch_url {"url":"${MODELS_URL}"`);
    expect(lines[0]).toEndWith("(ok)");
    expect(lines[1]).toEndWith("(error)");
  });
});
