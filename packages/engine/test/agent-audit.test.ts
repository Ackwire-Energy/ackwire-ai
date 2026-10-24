import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  auditInput,
  auditsCall,
  createToolGateway,
  decideApproval,
  ForbiddenError,
  grantScopes,
  listAudit,
  postPersonMessage,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("what the audit keeps of a call", () => {
  test("secrets masked, keys under secret names dropped, long text cut", () => {
    const kept = auditInput({
      to: "joao@acme.com",
      subject: "Proposta",
      headers: { Authorization: "Bearer abcdefghijklmnop", "X-Trace": "1" },
      password: "hunter2",
      note: "use sk-ant-abcdefghijklmnopqrstuv to call it",
      body: "x".repeat(800),
      list: Array.from({ length: 25 }, (_, i) => i),
    });
    expect(kept).toMatchObject({
      to: "joao@acme.com",
      subject: "Proposta",
      headers: { Authorization: "***", "X-Trace": "1" },
      password: "***",
    });
    expect(kept.note).not.toContain("abcdefghijklmnopqrstuv");
    expect(String(kept.body).length).toBeLessThan(510);
    expect(kept.list).toHaveLength(21);
    expect(JSON.stringify(kept)).not.toContain("hunter2");
  });

  test("changes, sends and a connected app's reads; not looking around inside; every refusal", () => {
    expect(auditsCall("external", {}, "done")).toBe(true);
    expect(auditsCall("internal", {}, "done")).toBe(true);
    expect(auditsCall("computer", {}, "pending")).toBe(true);
    expect(auditsCall("elsewhere", {}, "done")).toBe(true);
    expect(auditsCall("read", { connectionId: "c1" }, "done")).toBe(true);
    expect(auditsCall("read", {}, "done")).toBe(false);
    expect(auditsCall("here", {}, "done")).toBe(false);
    expect(auditsCall("pass", {}, "done")).toBe(false);
    expect(auditsCall("directory", {}, "done")).toBe(false);
    expect(auditsCall("read", {}, "refused")).toBe(true);
    expect(auditsCall("here", {}, "failed")).toBe(true);
    expect(auditsCall("directory", {}, "refused")).toBe(false);
  });
});

describe("agents' tool calls in the audit log", () => {
  async function runIn(fx: Fixture): Promise<ToolContext> {
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "abre a tarefa e manda o resumo",
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

  /** Fake tools: an internal write, one that throws, one that needs approval, a workspace read, a connector read. */
  function fakeTools(connectionId: string) {
    const obj = { type: "object", properties: { title: { type: "string" } }, additionalProperties: true };
    const tool = (name: string, scope: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
      name,
      description: name,
      scope,
      inputSchema: obj,
      async execute() {
        return { content: `${name} ok` };
      },
      ...extra,
    });
    const tools = [
      tool("create_issue", "issues:write"),
      tool("broken_issue", "issues:write", {
        async execute() {
          throw new Error("the issue tracker is down");
        },
      }),
      tool("close_all_issues", "issues:write", { sensitive: true }),
      tool("search_context", "context:read"),
      tool("sentry_list_issues", "sentry:issues.read", { connectionId, connectorLabel: "Sentry" }),
      tool("drive_delete", "drive:write"),
    ];
    const source: ToolSource = { name: "fake", tools: async () => tools };
    return createToolGateway({ sources: [source] });
  }

  async function team(fx: Fixture) {
    const [conn] = await fx.db
      .insert(schema.connectorConnections)
      .values({ orgId: fx.org.id, connector: "sentry", label: "Sentry", serverUrl: "https://mcp.sentry.dev", authType: "none" })
      .returning();
    await grantScopes(fx.db, fx.org.id, fx.agent.id, [
      { connectionId: null, scope: "issues:write" },
      { connectionId: null, scope: "context:read" },
      { connectionId: conn?.id ?? null, scope: "sentry:issues.read" },
    ]);
    return fakeTools(conn?.id ?? "");
  }

  const toolRows = (fx: Fixture) =>
    fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "tool.call")).orderBy(schema.auditLog.id);

  test("what went through, failed, was refused or waits; with the run, the channel and the person behind it", async () => {
    f = await setup();
    const tools = await team(f);
    const ctx = await runIn(f);
    const call = (name: string, input: Record<string, unknown> = {}) =>
      tools.invoke(ctx, { toolUseId: `tu_${name}_${Math.random()}`, name, input });

    await call("create_issue", { title: "Login quebrado" });
    await call("broken_issue", { title: "Outra" });
    await call("drive_delete", { title: "relatorio.pdf" }); // no drive:write: refused
    await call("search_context", { title: "login" }); // looking around: not kept
    await call("sentry_list_issues", { title: "login" }); // someone's data: kept
    const asked = await call("close_all_issues", { title: "tudo", why: "the board was cleaned up by hand" });
    expect(asked.type).toBe("approval");

    const rows = await toolRows(f);
    expect(rows.map((r) => [r.targetId, r.outcome])).toEqual([
      ["create_issue", "done"],
      ["broken_issue", "failed"],
      ["drive_delete", "refused"],
      ["sentry_list_issues", "done"],
      ["close_all_issues", "pending"],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        orgId: f.org.id,
        actorType: "agent",
        actorId: f.agent.id,
        runId: ctx.runId,
        channelId: f.general.id,
        onBehalfOfUserId: f.owner.id,
      });
    }
    expect(rows[0]?.details).toMatchObject({ kind: "internal", behind: "person", input: { title: "Login quebrado" } });
    expect(rows[1]?.details.reason).toContain("the issue tracker is down");
    expect(rows[2]?.details.reason).toContain("lacks the scope drive:write");
    expect(rows[3]?.details).toMatchObject({ kind: "read", connector: "Sentry" });
    const approvalId = asked.type === "approval" ? asked.approval.id : "";
    expect(rows[4]?.details).toMatchObject({ approvalId, reason: "the board was cleaned up by hand" });

    // A person approves: their decision, then the action the agent ran.
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approvalId, { decision: "approve" });
    const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!approved) throw new Error("no approval");
    await tools.executeApproved(ctx, approved);
    const [decision] = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "approval.approved"));
    expect(decision).toMatchObject({
      actorType: "person",
      actorId: f.owner.id,
      targetId: approvalId,
      runId: ctx.runId,
    });
    expect(decision?.details).toMatchObject({ tool: "close_all_issues", agentId: f.agent.id });
    const ran = (await toolRows(f)).at(-1);
    expect(ran).toMatchObject({ targetId: "close_all_issues", outcome: "done", onBehalfOfUserId: f.owner.id });
    expect(ran?.details.approvalId).toBe(approvalId);
  });

  test("admins read it, newest first, with names, filters and pages; members can't", async () => {
    f = await setup();
    const tools = await team(f);
    const ctx = await runIn(f);
    for (const name of ["create_issue", "drive_delete", "create_issue"]) {
      await tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input: { title: name } });
    }

    const all = await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool" });
    expect(all.rows.map((r) => r.target.id)).toEqual(["create_issue", "drive_delete", "create_issue"]);
    expect(all.rows[0]).toMatchObject({
      actor: { type: "agent", id: f.agent.id, name: f.agent.name },
      onBehalfOf: { id: f.owner.id, name: "ana" },
      channelId: f.general.id,
    });
    expect(all.next).toBeNull();

    const refused = await listAudit(f.db, f.owner.id, f.org.id, { outcome: "refused" });
    expect(refused.rows.map((r) => r.target.id)).toEqual(["drive_delete"]);
    const byAgent = await listAudit(f.db, f.owner.id, f.org.id, { actorType: "agent", actorId: f.agent.id });
    expect(byAgent.rows).toHaveLength(3);

    const first = await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool", limit: 2 });
    expect(first.rows).toHaveLength(2);
    const second = await listAudit(f.db, f.owner.id, f.org.id, { kind: "tool", limit: 2, before: first.next ?? "" });
    expect(second.rows.map((r) => r.target.id)).toEqual(["create_issue"]);
    expect(second.next).toBeNull();

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(listAudit(f.db, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
