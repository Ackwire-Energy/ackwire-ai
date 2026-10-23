import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  approvalView,
  bridgeToolsFor,
  grantScopes,
  insertMessage,
  type RoutineAccess,
  type RoutineBrief,
  type RunAuthority,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
} from "../src";
import { carriesCredential, maskCredentials } from "../src/tool-detail";
import { CREDENTIAL_REFUSAL } from "../src/tools/gateway";
import { REFUSALS, takeWhy, toolKind, toolPolicy, WHY_MIN_CHARS, WHY_REFUSAL, withWhy } from "../src/tools/run-policy";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "Two refunds were asked for the same order today; the second one would charge the customer twice.";

// ── The table, on its own ─────────────────────────────────────────────────────

const briefOf = (access: RoutineAccess): RoutineBrief => ({
  routineId: "00000000-0000-4000-8000-000000000001",
  routineRunId: "00000000-0000-4000-8000-000000000002",
  name: "Pedidos do dia",
  creatorUserId: "user_creator",
  deliverTo: { channelId: "00000000-0000-4000-8000-000000000003", threadId: null },
  access,
  report: "when_new",
  trigger: "schedule",
  dueAt: new Date().toISOString(),
});
const routine = (access: RoutineAccess): RunAuthority => ({ kind: "routine", personId: null, brief: briefOf(access) });
const unattended: RunAuthority = { kind: "unattended", personId: null, reason: "routine_report" };
const person: RunAuthority = { kind: "person", personId: "user_ana" };

const builtIn = (name: string, scope = "") => ({ name, scope, connectionId: null });
const app = (name: string, scope: string, sensitive = false) => ({ name, scope, connectionId: "conn_1", sensitive });
const decide = (authority: RunAuthority, tool: Parameters<typeof toolPolicy>[1]) => toolPolicy(authority, tool).action;

describe("run policy table", () => {
  test("classifies tools by name, scope and whether they are a connected app's", () => {
    expect(toolKind(builtIn("list_issues", "issues:read")).kind).toBe("read");
    expect(toolKind(builtIn("create_issue", "issues:write"))).toEqual({ kind: "internal", area: "issues" });
    expect(toolKind(builtIn("remember", "memory:write"))).toEqual({ kind: "internal", area: "memory" });
    expect(toolKind(builtIn("list_routines", "schedule:write")).kind).toBe("read");
    expect(toolKind(builtIn("create_routine", "schedule:write")).kind).toBe("elsewhere");
    expect(toolKind(builtIn("post_message")).kind).toBe("elsewhere");
    expect(toolKind(builtIn("react")).kind).toBe("here");
    expect(toolKind(builtIn("hand_off")).kind).toBe("hand_off");
    // A tool the table doesn't know: a sensitive one asks a person, any other is only for a person's run.
    expect(toolKind({ ...builtIn("deploy_app"), sensitive: true }).kind).toBe("external");
    expect(toolKind(builtIn("some_new_tool")).kind).toBe("unknown");
    expect(toolKind(app("github_get_issue", "github:issues.read")).kind).toBe("read");
    expect(toolKind(app("github_create_issue", "github:issues.write")).kind).toBe("external");
    expect(toolKind(app("mail_support_send", "mail:send")).kind).toBe("external");
    expect(toolKind(app("mail_support_read", "mail:read")).kind).toBe("read");
    expect(toolKind(app("git_clone", "github:git.read"))).toEqual({ kind: "internal", area: "code" });
    // A new built-in tool the table doesn't know is for people's runs only.
    expect(toolKind(builtIn("brand_new_tool")).kind).toBe("unknown");
  });

  test("routine, read: reads and hand_off only; writes refused with a reason for the model", () => {
    const r = routine("read");
    expect(decide(r, builtIn("list_issues", "issues:read"))).toBe("allow");
    expect(decide(r, builtIn("search_context", "context:read"))).toBe("allow");
    expect(decide(r, app("github_get_issue", "github:issues.read"))).toBe("allow");
    expect(decide(r, builtIn("hand_off"))).toBe("allow");
    expect(toolPolicy(r, builtIn("create_issue", "issues:write"))).toEqual({
      action: "refuse",
      reason: REFUSALS.routineReadOnly,
    });
    expect(decide(r, app("github_create_issue", "github:issues.write"))).toBe("refuse");
    expect(decide(r, builtIn("remember", "memory:write"))).toBe("refuse");
    expect(toolPolicy(r, builtIn("post_message"))).toEqual({ action: "refuse", reason: REFUSALS.routineElsewhere });
    const elsewhere = ["send_dm", "ask_agent", "tell_agent", "schedule_reminder", "create_routine", "request_secret"];
    for (const name of elsewhere) expect(decide(r, builtIn(name))).toBe("refuse");
    expect(toolPolicy(r, builtIn("ask_user"))).toEqual({ action: "refuse", reason: REFUSALS.routineAskUser });
    expect(toolPolicy(r, builtIn("react"))).toEqual({ action: "refuse", reason: REFUSALS.routineReact });
  });

  test("routine, act: internal changes run, connected apps ask a person, speaking elsewhere stays refused", () => {
    const r = routine("act");
    expect(decide(r, builtIn("create_issue", "issues:write"))).toBe("allow");
    expect(decide(r, builtIn("update_wiki_page", "wiki:write"))).toBe("allow");
    expect(decide(r, app("git_clone", "github:git.read"))).toBe("allow");
    expect(decide(r, app("github_create_issue", "github:issues.write"))).toBe("approve");
    expect(decide(r, app("github_merge_pr", "github:pr.merge", true))).toBe("approve");
    expect(decide(r, app("mail_support_send", "mail:send"))).toBe("approve");
    expect(decide(r, builtIn("post_message"))).toBe("refuse");
    expect(decide(r, builtIn("update_routine", "schedule:write"))).toBe("refuse");
  });

  test("unattended: reads, the reply here, issues and memory; elsewhere refused; connected apps ask", () => {
    expect(decide(unattended, builtIn("react"))).toBe("allow");
    expect(decide(unattended, builtIn("ask_user"))).toBe("allow");
    expect(decide(unattended, builtIn("pass"))).toBe("allow");
    expect(decide(unattended, builtIn("create_issue", "issues:write"))).toBe("allow");
    expect(decide(unattended, builtIn("remember", "memory:write"))).toBe("allow");
    expect(toolPolicy(unattended, builtIn("post_message"))).toEqual({
      action: "refuse",
      reason: REFUSALS.unattendedElsewhere,
    });
    expect(decide(unattended, builtIn("send_dm"))).toBe("refuse");
    expect(decide(unattended, builtIn("tell_agent"))).toBe("refuse");
    expect(decide(unattended, builtIn("schedule_reminder", "schedule:write"))).toBe("refuse");
    expect(decide(unattended, builtIn("update_wiki_page", "wiki:write"))).toBe("refuse");
    expect(decide(unattended, builtIn("run_code", "sandbox:run"))).toBe("refuse");
    expect(decide(unattended, builtIn("hand_off"))).toBe("refuse");
    expect(decide(unattended, app("github_create_issue", "github:issues.write"))).toBe("approve");
  });

  test("person: unchanged (only hand_off, which is background work's)", () => {
    for (const tool of [
      builtIn("post_message"),
      builtIn("send_dm"),
      builtIn("create_routine", "schedule:write"),
      builtIn("ask_user"),
      app("github_create_issue", "github:issues.write"),
      app("github_merge_pr", "github:pr.merge", true),
    ]) {
      expect(decide(person, tool)).toBe("allow");
    }
    expect(toolPolicy(person, builtIn("hand_off"))).toEqual({ action: "refuse", reason: REFUSALS.handOffOnly });
  });

  test("why: added to the schema as required, taken out of the input, too short is no reason", () => {
    const schemaDef = { type: "object", properties: { order: { type: "string" } }, required: ["order"] };
    const listed = withWhy(schemaDef);
    expect(listed.required).toEqual(["order", "why"]);
    expect((listed.properties as Record<string, { minLength?: number }>).why?.minLength).toBe(WHY_MIN_CHARS);
    expect(withWhy(listed)).toEqual(listed);
    expect(takeWhy(schemaDef, { order: "7", why: WHY })).toEqual({ why: WHY, input: { order: "7" } });
    expect(takeWhy(schemaDef, { order: "7", why: "because" })).toEqual({ why: null, input: { order: "7" } });
    expect(takeWhy(schemaDef, { order: "7" }).why).toBeNull();
  });
});

// ── The gateway applies it: listing, every call, the bridge ──────────────────

const CONNECTION = "00000000-0000-4000-8000-0000000000aa";
const executed: Record<string, unknown>[] = [];

/** A connected app with one read and one write (no network). */
const appSource: ToolSource = {
  name: "acme-shop",
  tools: async () => [
    {
      name: "shop_list_orders",
      description: "List today's orders.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      scope: "shop:orders.read",
      connectionId: CONNECTION,
      connectorLabel: "Shop",
      execute: async () => ({ content: "2 orders" }),
    },
    {
      name: "shop_refund_order",
      description: "Refund an order.",
      inputSchema: {
        type: "object",
        properties: { order: { type: "string" } },
        required: ["order"],
        additionalProperties: false,
      },
      scope: "shop:orders.write",
      connectionId: CONNECTION,
      connectorLabel: "Shop",
      describe: (input) => ({ title: `Refund order ${String(input.order)}` }),
      execute: async (input) => {
        executed.push(input);
        return { content: "refunded" };
      },
    },
  ],
};

async function gatewaySetup() {
  executed.length = 0;
  f = await setup({
    chatTools: true,
    react: true,
    askUser: true,
    handOff: true,
    issueTools: true,
    scheduleTools: true,
    askAgent: true,
    toolSources: [appSource],
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
}

type Kind = "person" | "unattended" | RoutineAccess;

/** A run of the agent in #general and its tool context: a person's, an unattended one, or a routine's. */
async function runAs(kind: Kind) {
  const brief =
    kind === "read" || kind === "act"
      ? { ...briefOf(kind), deliverTo: { channelId: f.general.id, threadId: null } }
      : null;
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author:
      kind === "unattended"
        ? { type: "agent", agentId: f.agent.id, runId: null, hop: 1 }
        : { type: "person", userId: f.owner.id },
    body: brief ? "Check today's orders." : "hi",
    meta: brief ? { routineBrief: brief } : undefined,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      ...(brief ? { background: true } : {}),
    })
    .returning();
  if (!run) throw new Error("no run");
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    ...(brief ? { background: true } : {}),
  };
  return { run, ctx, brief };
}

const tools = () => {
  if (!f.tools) throw new Error("no tools");
  return f.tools;
};
const listed = async (ctx: ToolContext) => new Map((await tools().list(ctx)).map((t) => [t.name, t]));
const call = (ctx: ToolContext, name: string, input: Record<string, unknown>) =>
  tools().invoke(ctx, { toolUseId: `tu_${name}_${crypto.randomUUID()}`, name, input });
const requiresWhy = (t: ToolDefinition | undefined) =>
  Array.isArray(t?.inputSchema.required) && ((t?.inputSchema.required ?? []) as string[]).includes("why");

describe("the gateway applies the run policy", () => {
  test("routine, read: refused tools aren't listed, and a call is refused anyway with the reason", async () => {
    await gatewaySetup();
    const { ctx } = await runAs("read");
    const names = await listed(ctx);
    for (const name of ["post_message", "send_dm", "react", "ask_user", "create_issue", "shop_refund_order"]) {
      expect(names.has(name)).toBe(false);
    }
    for (const name of ["list_issues", "shop_list_orders", "hand_off", "list_routines"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(await call(ctx, "post_message", { channel: "general", text: "oi" })).toMatchObject({
      type: "result",
      output: { isError: true, content: REFUSALS.routineElsewhere },
    });
    expect(await call(ctx, "shop_refund_order", { order: "7", why: WHY })).toMatchObject({
      output: { isError: true, content: REFUSALS.routineReadOnly },
    });
    expect(await call(ctx, "shop_list_orders", {})).toMatchObject({
      type: "result",
      output: { content: expect.stringContaining("2 orders") },
    });
    expect(executed).toEqual([]);
  });

  test("routine, act: issue writes run; a connected app's write asks a person, with origin and why", async () => {
    await gatewaySetup();
    const { ctx, brief } = await runAs("act");
    const names = await listed(ctx);
    expect(names.has("create_issue")).toBe(true);
    expect(requiresWhy(names.get("create_issue"))).toBe(false);
    const refund = names.get("shop_refund_order");
    expect(refund?.sensitive).toBe(true);
    expect(requiresWhy(refund)).toBe(true);
    expect(names.has("post_message")).toBe(false);

    const result = await call(ctx, "shop_refund_order", { order: "7", why: WHY });
    if (result.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
    expect(result.approval).toMatchObject({
      why: WHY,
      params: { order: "7" },
      channelId: f.general.id,
      origin: { kind: "routine", routineId: brief?.routineId, routineName: "Pedidos do dia" },
    });
    expect(approvalView(result.approval)).toMatchObject({
      why: WHY,
      origin: { kind: "routine", routineId: brief?.routineId, routineName: "Pedidos do dia" },
    });
    expect(executed).toEqual([]);
  });

  test("unattended: posting elsewhere refused, the reply here allowed, connector writes ask", async () => {
    await gatewaySetup();
    const { ctx } = await runAs("unattended");
    const names = await listed(ctx);
    expect(names.has("post_message")).toBe(false);
    expect(names.has("send_dm")).toBe(false);
    expect(names.has("schedule_reminder")).toBe(false);
    expect(names.has("hand_off")).toBe(false);
    expect(names.has("react")).toBe(true);
    expect(requiresWhy(names.get("ask_user"))).toBe(true);
    expect(names.get("shop_refund_order")?.sensitive).toBe(true);

    expect(await call(ctx, "post_message", { channel: "general", text: "oi" })).toMatchObject({
      output: { isError: true, content: REFUSALS.unattendedElsewhere },
    });
    expect(await call(ctx, "react", { emoji: "👍" })).toMatchObject({
      type: "result",
      output: { data: { reacted: expect.anything() } },
    });
    const result = await call(ctx, "shop_refund_order", { order: "9", why: WHY });
    if (result.type !== "approval") throw new Error("expected an approval");
    expect(result.approval.origin).toEqual({ kind: "unattended" });
  });

  test("person: unchanged, except hand_off and the why on what asks a person", async () => {
    await gatewaySetup();
    const { ctx } = await runAs("person");
    const names = await listed(ctx);
    for (const name of ["post_message", "send_dm", "react", "ask_user", "create_issue", "schedule_reminder"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has("hand_off")).toBe(false);
    // Not a write anybody approves for a person: it runs as before.
    expect(names.get("shop_refund_order")?.sensitive).toBeUndefined();
    expect(await call(ctx, "shop_refund_order", { order: "3" })).toMatchObject({
      type: "result",
      output: { content: "refunded" },
    });
    expect(executed).toEqual([{ order: "3" }]);
  });

  test("a run nobody is behind never sends a credential, through any tool; a person's run is unchanged", async () => {
    await gatewaySetup();
    const key = "AKIAIOSFODNN7EXAMPLE";
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    for (const kind of ["read", "unattended"] as const) {
      const { ctx } = await runAs(kind);
      for (const query of [`customer ${key}`, privateKey]) {
        expect(await call(ctx, "list_issues", { query })).toMatchObject({
          type: "result",
          output: { isError: true, content: CREDENTIAL_REFUSAL, data: { code: "tool.credential" } },
        });
      }
      // Anything else still runs.
      const fine = await call(ctx, "list_issues", { query: "checkout" });
      expect(fine.type === "result" && fine.output.isError).toBeFalsy();
    }
    const { ctx } = await runAs("person");
    const asked = await call(ctx, "list_issues", { query: `customer ${key}` });
    expect(asked.type === "result" && asked.output.content).not.toBe(CREDENTIAL_REFUSAL);
  });

  test("credentials by their format: found in any value, masked in what people read", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(carriesCredential({ query: "AKIAIOSFODNN7EXAMPLE" })).toBe(true);
    expect(carriesCredential(`a key:\n${pem}`)).toBe(true);
    expect(carriesCredential({ query: "checkout errors since Monday" })).toBe(false);
    expect(maskCredentials(`found ${pem} in the repo, and ghp_abcdefghijklmnopqrstuvwxyz0123`)).toBe(
      "found •••• in the repo, and ••••",
    );
  });

  test("the bridge lists exactly what the model loop does, why included", async () => {
    await gatewaySetup();
    for (const kind of ["read", "act", "unattended", "person"] as const) {
      const { run, ctx } = await runAs(kind);
      const loop = await tools().list(ctx);
      const bridged = await bridgeToolsFor(
        { db: f.db, pubsub: f.pubsub, tools: tools() },
        { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId: "" },
      );
      expect(bridged.map((t) => t.name).sort()).toEqual(loop.map((t) => t.name).sort());
      const refund = bridged.find((t) => t.name === "shop_refund_order");
      if (kind === "read") expect(refund).toBeUndefined();
      else if (kind !== "person") expect(((refund?.inputSchema.required ?? []) as string[]).includes("why")).toBe(true);
    }
  });
});

describe("why: required on every call that asks a person", () => {
  const sensitiveSource: ToolSource = {
    name: "danger",
    tools: async () => [
      {
        name: "shop_delete_customer",
        description: "Delete a customer.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        scope: "shop:customers.delete",
        connectionId: CONNECTION,
        sensitive: true,
        execute: async () => ({ content: "deleted" }),
      },
    ],
  };

  test("missing or short why is refused, no approval; a good one is kept on the approval, not its params", async () => {
    f = await setup({ askUser: true, toolSources: [sensitiveSource] });
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
    const { ctx } = await runAs("person");
    const listedTool = (await tools().list(ctx)).find((t) => t.name === "shop_delete_customer");
    expect(requiresWhy(listedTool)).toBe(true);

    expect(await call(ctx, "shop_delete_customer", { id: "c1" })).toEqual({
      type: "result",
      output: { content: WHY_REFUSAL, isError: true, data: { code: "tool.why_missing" } },
    });
    expect(await call(ctx, "shop_delete_customer", { id: "c1", why: "  short  " })).toMatchObject({
      output: { content: WHY_REFUSAL, isError: true },
    });
    expect(await f.db.select().from(schema.approvals)).toEqual([]);

    const result = await call(ctx, "shop_delete_customer", { id: "c1", why: `  ${WHY}  ` });
    if (result.type !== "approval") throw new Error("expected an approval");
    const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, result.approval.id));
    expect(row?.why).toBe(WHY);
    expect(row?.params).toEqual({ id: "c1" });
    expect(row?.origin).toBeNull();
    expect(approvalView(result.approval).why).toBe(WHY);
  });

  test("ask_user takes a why too and hands it on with the question", async () => {
    f = await setup({ askUser: true });
    const { ctx } = await runAs("person");
    expect(await call(ctx, "ask_user", { question: "Which store?" })).toMatchObject({
      output: { content: WHY_REFUSAL, isError: true },
    });
    expect(await call(ctx, "ask_user", { question: "Which store?", choices: ["Centro", "Norte"], why: WHY })).toEqual({
      type: "question",
      text: "Which store?",
      choices: ["Centro", "Norte"],
      why: WHY,
    });
  });
});
