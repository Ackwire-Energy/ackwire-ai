import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  actionLevel,
  COMPOSIO_EXECUTOR,
  ConflictError,
  type CustomDeps,
  composioActions,
  connectCustomServer,
  connectorGrantValidator,
  createAgent,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  deleteAgent,
  ForbiddenError,
  grantScopes,
  type InvokeResult,
  insertMessage,
  listApprovalRules,
  type McpConnect,
  mcpSessionOver,
  type RoutineBrief,
  removeApprovalRule,
  revokeConnection,
  saveCustomTools,
  setAgentAccess,
  setAgentScopes,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("what an action named by its slug does", () => {
  test("reads only with a read verb and no other verb; sensitive on any sensitive word; else a write", () => {
    const cases: [string, ReturnType<typeof actionLevel>][] = [
      ["GITHUB_LIST_PULL_REQUESTS", "read"],
      ["GITHUB_GET_A_PULL_REQUEST", "read"],
      ["GITHUB_SEARCH_REPOSITORIES", "read"],
      ["GITHUB_LIST_DEPLOYMENTS", "read"],
      // "open" is a verb of its own: it may open something, so it isn't taken as a read.
      ["GITHUB_LIST_OPEN_ISSUES", "write"],
      ["GITHUB_CREATE_AN_ISSUE_COMMENT", "write"],
      ["GITHUB_CREATE_A_DEPLOYMENT", "write"],
      ["SLACK_CHANNELS", "write"],
      ["LINEAR_GET_PROMOTE_STATUS", "write"],
      ["X_LIST_AND_DELETE_Y", "sensitive"],
      ["GITHUB_MERGE_A_PULL_REQUEST", "sensitive"],
      ["GMAIL_SEND_EMAIL", "sensitive"],
      ["GOOGLEDRIVE_SHARE_FILE", "sensitive"],
    ];
    expect(cases.map(([slug]) => [slug, actionLevel(slug)])).toEqual(cases);
  });
});

describe("the actions one call of Composio's executor runs", () => {
  const item = (tool_slug: string, args: unknown = { owner: "acme" }) => ({ tool_slug, arguments: args });
  test("only the documented shape: its slugs, each once; anything else says nothing (null)", () => {
    const cases: [Record<string, unknown>, string[] | null][] = [
      [
        { tools: [item("GITHUB_LIST_PULL_REQUESTS")], sync_response_to_workbench: false },
        ["GITHUB_LIST_PULL_REQUESTS"],
      ],
      [
        {
          tools: [
            item("GITHUB_LIST_PULL_REQUESTS"),
            { tool_slug: "GITHUB_GET_A_PULL_REQUEST" },
            item("GITHUB_LIST_PULL_REQUESTS"),
          ],
          thought: "Reading the open pull requests",
          sync_response_to_workbench: false,
          current_step: "FETCHING_PRS",
          current_step_metric: "1/2 repos",
          session_id: "s-1",
        },
        ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST"],
      ],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS")], sync_response_to_workbench: false, why: "x" }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS")], sync_response_to_workbench: "no" }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS")], thought: 3 }, null],
      [{ tools: [], sync_response_to_workbench: false }, null],
      [{ tools: Array.from({ length: 51 }, () => item("GITHUB_LIST_PULL_REQUESTS")) }, null],
      [{ tools: item("GITHUB_LIST_PULL_REQUESTS") }, null],
      [{ sync_response_to_workbench: false }, null],
      [{ tools: [{ ...item("GITHUB_LIST_PULL_REQUESTS"), retries: 2 }] }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS", ["acme"])] }, null],
      [{ tools: [item("github_list_pull_requests")] }, null],
      [{ tools: [item("LIST")] }, null],
      [{ tools: [item(`GITHUB_${"X".repeat(130)}`)] }, null],
      [{ tools: [item("COMPOSIO_REMOTE_WORKBENCH")] }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS"), "GITHUB_GET_A_PULL_REQUEST"] }, null],
    ];
    expect(cases.map(([input]) => composioActions(input))).toEqual(cases.map(([, out]) => out));
  });
});

// ── Through the Tool Gateway, with an in-process server shaped like Composio's ──────────────────────────

const WORKBENCH = "COMPOSIO_REMOTE_WORKBENCH";
const EXEC = `composio_${COMPOSIO_EXECUTOR}`;
const WHY = "The reporter is waiting on this issue: a short note tells them the team is on it.";

function composioMcp() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const build = () => {
    const server = new McpServer({ name: "composio", version: "1" });
    server.registerTool(
      COMPOSIO_EXECUTOR,
      {
        description: "Executes up to 50 tools in parallel.",
        inputSchema: {
          tools: z.array(z.object({ tool_slug: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })),
          thought: z.string().optional(),
          sync_response_to_workbench: z.boolean(),
          current_step: z.string().optional(),
          current_step_metric: z.string().optional(),
          session_id: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      async (args) => {
        calls.push({ tool: COMPOSIO_EXECUTOR, args });
        return text(`ran ${args.tools.map((t) => t.tool_slug).join(", ")}`);
      },
    );
    // No annotation: it asks because we name it, not because the server says so.
    server.registerTool(
      WORKBENCH,
      { description: "Runs Python in a sandbox", inputSchema: { code_to_execute: z.string() } },
      async (args) => {
        calls.push({ tool: WORKBENCH, args });
        return text("done");
      },
    );
    server.registerTool(
      "close_ticket",
      { description: "Close a ticket", inputSchema: { id: z.number() } },
      async (args) => {
        calls.push({ tool: "close_ticket", args });
        return text(`closed #${args.id}`);
      },
    );
    return server;
  };
  const connect: McpConnect = async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

/** A Composio server connected by address and its suggestions accepted: every agent's, whole (`connector:*`). */
async function composio(fx: Fixture, mcp: ReturnType<typeof composioMcp>, label = "Composio") {
  const deps: CustomDeps = {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: mcp.connect,
  };
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: `https://backend.composio.dev/v3/mcp/${label.toLowerCase().replace(/\W+/g, "-")}`,
    apiKey: "ck_fake_key_for_tests",
    label,
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, started.server.id);
  return { deps, serverId: started.server.id };
}

async function world(fx: Fixture) {
  const mcp = composioMcp();
  const server = await composio(fx, mcp);
  const gateway = createToolGateway({ sources: [createConnectorToolSource(server.deps)] });
  return { mcp, gateway, ...server };
}

/** A run of `agentId` a person asked for (or a routine's, with its brief), to call tools in. */
async function runOf(fx: Fixture, agentId = fx.agent.id, routine?: RoutineBrief): Promise<ToolContext> {
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: fx.owner.id },
    body: "@dev olha os PRs da acme/app",
    meta: routine ? { routineBrief: routine, background: true } : {},
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      background: Boolean(routine),
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

const exec = (...slugs: string[]) => ({
  tools: slugs.map((tool_slug, i) => ({ tool_slug, arguments: { owner: "acme", repo: "app", issue_number: 40 + i } })),
  sync_response_to_workbench: false,
});

let seq = 0;
const invoke = (gateway: ReturnType<typeof createToolGateway>, ctx: ToolContext, name: string, input: object) =>
  gateway.invoke(ctx, { toolUseId: `call-${++seq}`, name, input: input as Record<string, unknown> });

function asked(result: InvokeResult) {
  if (result.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
  return result.approval;
}

const toolCalls = async (fx: Fixture) =>
  (
    await fx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "tool.call"))
      .orderBy(schema.auditLog.createdAt, schema.auditLog.id)
  ).map((r) => ({
    outcome: r.outcome,
    kind: r.details.kind,
    approvalRules: r.details.approvalRules,
  }));
const rules = (fx: Fixture) => fx.db.select().from(schema.approvalRules);
const decide = (fx: Fixture, actorId: string, approvalId: string, input: Parameters<typeof decideApproval>[4]) =>
  decideApproval({ db: fx.db, pubsub: fx.pubsub }, actorId, fx.org.id, approvalId, input);

describe("reads through Composio's executor", () => {
  test("all reads run as the server's reads: no approval and no why needed, audited as reads", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const ctx = await runOf(f);
    const read = await invoke(gateway, ctx, EXEC, {
      ...exec("GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST"),
      why: WHY,
    });
    expect(read.type).toBe("result");
    // The `why` is ours: the server never sees it.
    expect(mcp.calls).toEqual([
      { tool: COMPOSIO_EXECUTOR, args: exec("GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST") },
    ]);
    expect((await invoke(gateway, ctx, EXEC, exec("GITHUB_SEARCH_REPOSITORIES"))).type).toBe("result");
    expect(mcp.calls).toHaveLength(2);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await toolCalls(f)).toEqual([
      { outcome: "done", kind: "read", approvalRules: undefined },
      { outcome: "done", kind: "read", approvalRules: undefined },
    ]);
  });

  test("an agent that may only write to the server, a write, a merge or an unknown shape asks as before", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    const write = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    expect(write.title).toBe("Composio: GITHUB_CREATE_AN_ISSUE_COMMENT");
    expect(write.approveAlways).toEqual({ tool: COMPOSIO_EXECUTOR, actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] });
    // A read next to a write is not a read.
    const mixed = asked(
      await invoke(gateway, ctx, EXEC, {
        ...exec("GITHUB_LIST_PULL_REQUESTS", "GITHUB_CREATE_AN_ISSUE_COMMENT"),
        why: WHY,
      }),
    );
    expect(mixed.approveAlways?.actions).toEqual(["GITHUB_LIST_PULL_REQUESTS", "GITHUB_CREATE_AN_ISSUE_COMMENT"]);
    // Not a shape we know: nothing is guessed, and nothing can be approved for good.
    for (const input of [
      { tools: [{ tool_slug: "github_list_pull_requests", arguments: {} }], sync_response_to_workbench: false },
      exec("GITHUB_LIST_PULL_REQUESTS", WORKBENCH),
    ]) {
      expect(asked(await invoke(gateway, ctx, EXEC, { ...input, why: WHY })).approveAlways).toBeNull();
    }
    // Write alone on the server: its reads aren't the agent's.
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: serverId, scope: `custom:${serverId}:write` }],
      connectorGrantValidator,
    );
    asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_LIST_PULL_REQUESTS"), why: WHY }));
    expect(mcp.calls).toEqual([]);
  });

  test("a routine's reads run; its writes always ask and are never approved for good", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const brief: RoutineBrief = {
      routineId: crypto.randomUUID(),
      routineRunId: crypto.randomUUID(),
      name: "Revisar PRs",
      creatorUserId: f.owner.id,
      deliverTo: { channelId: f.general.id, threadId: null },
      access: "act",
      report: "when_new",
      trigger: "schedule",
      dueAt: new Date().toISOString(),
    };
    const ctx = await runOf(f, f.agent.id, brief);
    expect((await invoke(gateway, ctx, EXEC, exec("GITHUB_LIST_PULL_REQUESTS"))).type).toBe("result");
    await f.db.insert(schema.approvalRules).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: serverId,
      tool: COMPOSIO_EXECUTOR,
      action: "GITHUB_CREATE_AN_ISSUE_COMMENT",
    });
    const write = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    expect(write.approveAlways).toBeNull();
    expect(mcp.calls.map((c) => c.tool)).toEqual([COMPOSIO_EXECUTOR]);
  });
});

describe("Aprovar sempre", () => {
  test("asks once, then not for the same kind with any values; asks for another action, tool, agent or server", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await grantScopes(f.db, f.org.id, other.id, [{ connectionId: serverId, scope: "connector:*" }]);
    const ctx = await runOf(f);
    const first = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    const view = await decide(f, f.owner.id, first.id, { decision: "approve", always: true });
    expect(view).toMatchObject({ status: "approved" });
    expect((await rules(f)).map((r) => [r.agentId, r.connectionId, r.tool, r.action, r.createdByUserId])).toEqual([
      [f.agent.id, serverId, COMPOSIO_EXECUTOR, "GITHUB_CREATE_AN_ISSUE_COMMENT", f.owner.id],
    ]);
    const [approved] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
    expect(approved?.details.always).toEqual({
      connectionId: serverId,
      tool: COMPOSIO_EXECUTOR,
      actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"],
    });

    // The same kind, other values, no why: it runs, and the audit says which rule let it.
    const again = await invoke(gateway, ctx, EXEC, {
      tools: [{ tool_slug: "GITHUB_CREATE_AN_ISSUE_COMMENT", arguments: { issue_number: 7, body: "Outro texto" } }],
      sync_response_to_workbench: false,
    });
    expect(again.type).toBe("result");
    expect(mcp.calls.at(-1)?.args.tools).toEqual([
      { tool_slug: "GITHUB_CREATE_AN_ISSUE_COMMENT", arguments: { issue_number: 7, body: "Outro texto" } },
    ]);
    const [rule] = await rules(f);
    expect((await toolCalls(f)).at(-1)).toEqual({ outcome: "done", kind: "external", approvalRules: [rule?.id] });
    expect(await f.db.select().from(schema.approvals)).toHaveLength(1);

    // Another action, or one more beside it, asks.
    asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE"), why: WHY }));
    asked(
      await invoke(gateway, ctx, EXEC, {
        ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT", "GITHUB_ADD_LABELS_TO_AN_ISSUE"),
        why: WHY,
      }),
    );
    // Another tool of the same server asks.
    asked(await invoke(gateway, ctx, "composio_close_ticket", { id: 1, why: WHY }));
    // Another agent asks.
    asked(
      await invoke(gateway, await runOf(f, other.id), EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }),
    );
    // Another Composio account asks.
    await composio(f, mcp, "Composio Two");
    asked(
      await invoke(gateway, ctx, `composio_two_${COMPOSIO_EXECUTOR}`, {
        ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"),
        why: WHY,
      }),
    );
    expect(mcp.calls).toHaveLength(1);
  });

  test("merge, deploy, workflows and sends are never offered nor honoured, even with a rule in the table", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    for (const slug of [
      "GITHUB_MERGE_A_PULL_REQUEST",
      "GITHUB_CREATE_A_DEPLOYMENT",
      "GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT",
      "VERCEL_PROMOTE_A_DEPLOYMENT",
      "GMAIL_SEND_EMAIL",
    ]) {
      await f.db.insert(schema.approvalRules).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        connectionId: serverId,
        tool: COMPOSIO_EXECUTOR,
        action: slug,
      });
      const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec(slug), why: WHY }));
      expect({ slug, offered: ask.approveAlways }).toEqual({ slug, offered: null });
      await expect(decide(f, f.owner.id, ask.id, { decision: "approve", always: true })).rejects.toMatchObject({
        code: "approval.always_unavailable",
      });
    }
    expect(mcp.calls).toEqual([]);
  });

  test("the workbench always asks, even set to write, and is never offered", async () => {
    f = await setup();
    const { mcp, gateway, deps, serverId } = await world(f);
    await saveCustomTools(deps, f.owner.id, f.org.id, serverId, {
      label: "Composio",
      tools: [{ name: WORKBENCH, access: "write", label: "Workbench" }],
    });
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, `composio_${WORKBENCH}`, { code_to_execute: "print(1)", why: WHY }));
    expect(ask.approveAlways).toBeNull();
    expect(mcp.calls).toEqual([]);
  });

  test("a plain tool of the server: its rule is the tool itself, and it outlives a renamed connection", async () => {
    f = await setup();
    const { mcp, gateway, deps, serverId } = await world(f);
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, "composio_close_ticket", { id: 1, why: WHY }));
    expect(ask.approveAlways).toEqual({ tool: "close_ticket", actions: [] });
    await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    expect((await rules(f)).map((r) => [r.tool, r.action])).toEqual([["close_ticket", ""]]);
    await saveCustomTools(deps, f.owner.id, f.org.id, serverId, { label: "Cmposio", tools: [] });
    expect((await invoke(gateway, ctx, "cmposio_close_ticket", { id: 2 })).type).toBe("result");
    expect(mcp.calls).toEqual([{ tool: "close_ticket", args: { id: 2 } }]);
    expect(await listApprovalRules(f.db, f.owner.id, f.org.id, f.agent.id)).toMatchObject([
      { connectionId: serverId, server: "Cmposio", tool: "close_ticket", toolLabel: "Close ticket", action: "" },
    ]);
  });

  test("only who decides the agent's approvals approves for good, and only where it's offered", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    await expect(decide(f, member.id, ask.id, { decision: "approve", always: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decide(f, f.owner.id, ask.id, { decision: "refuse", always: true })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await rules(f)).toEqual([]);
    // The agent's owner decides it even when they aren't an admin.
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    const theirs = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    await decide(f, member.id, theirs.id, { decision: "approve", always: true });
    expect((await rules(f)).map((r) => r.createdByUserId)).toEqual([member.id]);
  });

  test("removed, it asks again at once; without the scope it does nothing; it goes with the server or the agent", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    const always = async () => {
      const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
      await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    };
    await always();
    const [rule] = await listApprovalRules(f.db, f.owner.id, f.org.id, f.agent.id);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(removeApprovalRule(f.db, member.id, f.org.id, f.agent.id, rule?.id ?? "")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await removeApprovalRule(f.db, f.owner.id, f.org.id, f.agent.id, rule?.id ?? "");
    const removed = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.approval_rule_removed"), eq(schema.auditLog.targetId, f.agent.id)));
    expect(removed.map((r) => r.details)).toEqual([
      { connectionId: serverId, tool: COMPOSIO_EXECUTOR, action: "GITHUB_CREATE_AN_ISSUE_COMMENT" },
    ]);
    await always();

    // Without access to the server, a rule gives nothing: the call is refused before any rule is read.
    const none = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, none);
    const refused = await invoke(gateway, ctx, EXEC, exec("GITHUB_CREATE_AN_ISSUE_COMMENT"));
    expect(refused).toMatchObject({ type: "result", output: { isError: true } });
    expect(mcp.calls).toEqual([]);
    expect(await rules(f)).toHaveLength(1);

    // Deleting the agent takes its rules; disconnecting the server takes every agent's.
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db
      .insert(schema.approvalRules)
      .values({ orgId: f.org.id, agentId: other.id, connectionId: serverId, tool: "close_ticket", action: "" });
    await deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, f.owner.id, f.org.id, other.id);
    expect((await rules(f)).map((r) => r.agentId)).toEqual([f.agent.id]);
    await revokeConnection(f.db, f.owner.id, f.org.id, serverId);
    expect(await rules(f)).toEqual([]);
  });
});
