import { afterEach, expect, test } from "bun:test";
import { asc, schema } from "@agenteschat/db";
import {
  createToolGateway,
  DIRECTORY_MAX_TOOLS,
  describeCapabilities,
  grantScopes,
  postPersonMessage,
  presentTools,
  rankTools,
  type ToolContext,
  type ToolDefinition,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const TIKTOK = "0b5c7f3e-1d2a-4c8b-9e6f-2a7d4c1b9e00";
const SMALL = "6d1e2f3a-4b5c-4d7e-8f90-a1b2c3d4e5f6";

/** Names like the real TikTok Ads connector's (382 tools; here 96, 48 of them for reading). */
const AREAS = [
  "ad",
  "adgroup",
  "campaign",
  "catalog",
  "creative",
  "report",
  "pixel",
  "audience",
  "bc",
  "comment",
  "identity",
  "video",
];
const READ = ["get", "list", "info", "stats"];
const VERBS = [...READ, "create", "update", "status_update", "delete"];

function tiktokTools(executed: string[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const area of AREAS) {
    for (const verb of VERBS) {
      const name = `tiktok_${area}_${verb}`;
      out.push({
        name,
        description: `[TikTok] ${area} ${verb.replace("_", " ")}: ${verb === "create" ? "Creates" : "Works with"} ${area}s in an advertiser account.`,
        inputSchema: {
          type: "object",
          properties: {
            advertiser_id: { type: "string", description: "The advertiser account" },
            ...(verb === "create" ? { name: { type: "string", description: `The new ${area}'s name` } } : {}),
          },
          required: verb === "create" ? ["advertiser_id", "name"] : ["advertiser_id"],
        },
        scope: READ.includes(verb) ? "tiktok:read" : "tiktok:write",
        connectionId: TIKTOK,
        connectorLabel: "TikTok",
        sensitive: !READ.includes(verb),
        execute: async (input) => {
          executed.push(name);
          return { content: `${name} ok: ${JSON.stringify(input)}` };
        },
      });
    }
  }
  return out;
}

const smallTools = (): ToolDefinition[] =>
  ["list_events", "get_visitor"].map((n) => ({
    name: `himetrica_${n}`,
    description: `[Himetrica] ${n}`,
    inputSchema: { type: "object", properties: {} },
    scope: "himetrica:read",
    connectionId: SMALL,
    connectorLabel: "Himetrica",
    execute: async () => ({ content: `${n} ok` }),
  }));

const builtIn: ToolDefinition = {
  name: "list_issues",
  description: "List issues.",
  inputSchema: { type: "object", properties: {} },
  scope: "",
  execute: async () => ({ content: "no issues" }),
};

async function ctxOf(fx: Fixture): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "hi",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

test("presentTools: a big connector becomes find_tools + use_tool; built-ins and small connectors stay as they are", () => {
  const big = tiktokTools([]);
  expect(big.length).toBeGreaterThan(DIRECTORY_MAX_TOOLS);
  const shown = presentTools([builtIn, ...smallTools(), ...big]);
  expect(shown.map((t) => t.name)).toEqual([
    "list_issues",
    "himetrica_list_events",
    "himetrica_get_visitor",
    "tiktok_find_tools",
    "tiktok_use_tool",
  ]);
  expect(shown.find((t) => t.name === "tiktok_find_tools")?.description).toContain("96 in all");
  // At the limit, a connector is still listed whole.
  expect(presentTools(big.slice(0, DIRECTORY_MAX_TOOLS))).toHaveLength(DIRECTORY_MAX_TOOLS);
});

test("rankTools finds the tool for what the agent needs, by name first", () => {
  const tools = tiktokTools([]);
  expect(rankTools(tools, "tiktok", "create an ad")[0]?.name).toBe("tiktok_ad_create");
  expect(rankTools(tools, "tiktok", "campaign reports")[0]?.name).toMatch(/^tiktok_(campaign|report)_/);
  expect(rankTools(tools, "tiktok", "pausar")).toEqual([]);
});

test("through the directory the real tool runs with its own scope, schema, steps and approval", async () => {
  f = await setup();
  const executed: string[] = [];
  const tools = createToolGateway({
    sources: [{ name: "fake", tools: async () => [builtIn, ...tiktokTools(executed)] }],
  });
  const ctx = await ctxOf(f);
  // Only reading is granted.
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: TIKTOK, scope: "tiktok:read" }]);
  const call = (name: string, input: Record<string, unknown>) =>
    tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });

  // The search only knows the tools the agent holds.
  const found = await call("tiktok_find_tools", { query: "campaign" });
  expect(found).toMatchObject({ type: "result" });
  const text = found.type === "result" ? found.output.content : "";
  expect(text).toContain("tiktok_campaign_get");
  expect(text).not.toContain("tiktok_campaign_create");

  expect(await call("tiktok_use_tool", { tool: "campaign_get", arguments: { advertiser_id: "a1" } })).toMatchObject({
    type: "result",
    output: { content: 'tiktok_campaign_get ok: {"advertiser_id":"a1"}' },
  });
  // A tool it doesn't hold is unknown here, as if called directly.
  expect(await call("tiktok_use_tool", { tool: "tiktok_campaign_create", arguments: {} })).toMatchObject({
    output: { isError: true, content: expect.stringContaining('No TikTok tool named "tiktok_campaign_create"') },
  });
  // Bad input shows the schema the model never saw.
  expect(await call("tiktok_use_tool", { tool: "tiktok_ad_get", arguments: {} })).toMatchObject({
    output: { isError: true, content: expect.stringContaining("Input schema of tiktok_ad_get") },
  });

  // Writing is granted: a sensitive tool through the directory asks for approval as itself.
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: TIKTOK, scope: "tiktok:write" }]);
  const asked = await call("tiktok_use_tool", {
    tool: "tiktok_ad_create",
    arguments: { advertiser_id: "a1", name: "Black Friday" },
  });
  expect(asked).toMatchObject({ type: "approval", approval: { tool: "tiktok_ad_create", connectionId: TIKTOK } });
  expect(executed).toEqual(["tiktok_campaign_get"]);

  // The run's steps name the real tools, never `use_tool`.
  const steps = await f.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq));
  const called = steps.filter((s) => s.kind === "tool_call").map((s) => s.data.name);
  expect(called).toEqual([
    "tiktok_find_tools",
    "tiktok_campaign_get",
    "tiktok_use_tool",
    "tiktok_ad_get",
    "tiktok_ad_create",
  ]);
});

test("the prompt names a big connector in one line, with how to find its tools and how many ask approval", () => {
  const text = describeCapabilities(presentTools([builtIn, ...smallTools(), ...tiktokTools([])]));
  expect(text).toContain(
    "- TikTok (96 tools): find the one you need with `tiktok_find_tools`, then run it with `tiktok_use_tool`.",
  );
  expect(text).toContain("- Himetrica: `himetrica_get_visitor`, `himetrica_list_events`");
  expect(text).toContain("48 TikTok tools (its search marks them)");
  expect(text).not.toContain("tiktok_ad_create");
  expect(text.length).toBeLessThan(2_000);
});
