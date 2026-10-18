import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { textOf } from "@agenteschat/providers";
import {
  actionHash,
  canonicalJson,
  createToolGateway,
  decideApproval,
  drainOutbox,
  expireApprovals,
  ForbiddenError,
  getApproval,
  grantScopes,
  isSensitive,
  listApprovals,
  listMessages,
  postPersonMessage,
  setAgentScopes,
  type ToolContext,
  validateJson,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("validateJson", () => {
  const schemaDef = {
    type: "object",
    properties: {
      repo: { type: "string", minLength: 1 },
      pr: { type: "integer", minimum: 1 },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["repo", "pr"],
    additionalProperties: false,
  };
  test("accepts valid input and reports every problem", () => {
    expect(validateJson(schemaDef, { repo: "a/b", pr: 3, tags: ["x"] })).toEqual([]);
    expect(validateJson(schemaDef, { pr: 0, extra: 1, tags: [2] })).toEqual([
      "input.repo: required",
      "input.pr: below 1",
      "input.extra: not allowed",
      "input.tags[0]: expected string",
    ]);
    expect(validateJson(schemaDef, "nope")).toEqual(["input: expected object"]);
  });
  test("canonicalJson sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  test("merge, deploy and rollback are always sensitive", () => {
    expect(isSensitive({ name: "github_merge_pr", scope: "github:pr.merge" })).toBe(true);
    expect(isSensitive({ name: "vercel_deploy", scope: "x" })).toBe(true);
    expect(isSensitive({ name: "x", scope: "infra:rollback" })).toBe(true);
    expect(isSensitive({ name: "github_get_pr", scope: "github:pr.read" })).toBe(false);
    expect(isSensitive({ name: "emerged", scope: "a" })).toBe(false);
  });
});

describe("Tool Gateway", () => {
  const ctxOf = async (fx: Fixture): Promise<ToolContext> => {
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
  };

  test("lists only granted tools; scope, unknown tools and bad input are refused without running", async () => {
    f = await setup();
    const gh = fakeGithub();
    const tools = createToolGateway({ sources: [gh.source] });
    const ctx = await ctxOf(f);
    expect(await tools.list(ctx)).toEqual([]);
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "github:pr.read" }]);
    expect((await tools.list(ctx)).map((t) => t.name)).toEqual(["github_broken", "github_get_pr"]);

    const call = (name: string, input: Record<string, unknown>) =>
      tools.invoke(ctx, { toolUseId: `tu_${name}_${Math.random()}`, name, input });
    // The model asks for a tool it was not given: refused by scope, never by prompt.
    expect(await call("github_merge_pr", { repo: "a/b", pr: 1 })).toEqual({
      type: "result",
      output: { content: "Not allowed: this agent lacks the scope github:pr.merge", isError: true },
    });
    expect(await call("rm_rf", {})).toMatchObject({ output: { isError: true, content: "Unknown tool rm_rf" } });
    expect(await call("github_get_pr", { repo: "a/b" })).toMatchObject({
      output: { isError: true, content: "Invalid input: input.pr: required" },
    });
    expect(await call("github_broken", { repo: "a/b", pr: 1 })).toMatchObject({
      output: { isError: true, content: "Tool failed: upstream 502" },
    });
    expect(await call("github_get_pr", { repo: "a/b", pr: 7 })).toMatchObject({
      output: { content: "github_get_pr ok: a/b#7" },
    });
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr"]);
    const steps = await f.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq));
    expect(steps.filter((s) => s.kind === "tool_call")).toHaveLength(5);
    expect(steps.filter((s) => s.kind === "tool_result")).toHaveLength(5);
  });

  test("sensitive calls create an approval bound to the exact action; tampering is caught", async () => {
    f = await setup();
    const gh = fakeGithub();
    const tools = createToolGateway({ sources: [gh.source] });
    const ctx = await ctxOf(f);
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    const result = await tools.invoke(ctx, {
      toolUseId: "tu_1",
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 42 },
    });
    if (result.type !== "approval") throw new Error("expected an approval");
    const approval = result.approval;
    expect(approval).toMatchObject({
      status: "pending",
      title: "Merge PR #42 in acme/app",
      scope: "github:pr.merge",
      params: { repo: "acme/app", pr: 42 },
      ownerUserId: f.owner.id,
    });
    expect(approval.actionHash).toBe(
      actionHash({
        tool: "github_merge_pr",
        scope: "github:pr.merge",
        connectionId: null,
        params: { pr: 42, repo: "acme/app" },
      }),
    );
    expect(approval.expiresAt.getTime() - approval.createdAt.getTime()).toBeCloseTo(24 * 3600_000, -4);
    expect(gh.executed).toEqual([]);

    // Not approved yet: nothing runs.
    expect((await tools.executeApproved(ctx, approval)).isError).toBe(true);
    // Approved, but someone altered the params: refused.
    const tampered = { ...approval, status: "approved" as const, params: { repo: "acme/app", pr: 43 } };
    expect(await tools.executeApproved(ctx, tampered)).toMatchObject({
      isError: true,
      content: "Approval does not match the action",
    });
    // Approved as is: runs once, never twice.
    const approved = { ...approval, status: "approved" as const };
    expect((await tools.executeApproved(ctx, approved)).content).toBe("github_merge_pr ok: acme/app#42");
    expect((await tools.executeApproved(ctx, approved)).content).toBe("Already executed");
    expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
  });

  test("scope revoked while waiting: the approved action does not run", async () => {
    f = await setup();
    const gh = fakeGithub();
    const tools = createToolGateway({ sources: [gh.source] });
    const ctx = await ctxOf(f);
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    const result = await tools.invoke(ctx, {
      toolUseId: "tu_1",
      name: "github_close_pr",
      input: { repo: "a/b", pr: 1 },
    });
    if (result.type !== "approval") throw new Error("expected an approval");
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [], async () => null);
    expect((await tools.executeApproved(ctx, { ...result.approval, status: "approved" })).content).toContain(
      "lost the scope",
    );
    expect(gh.executed).toEqual([]);
  });

  test("a tool's checkCall refuses with its data kept, or merges its data into the result", async () => {
    f = await setup();
    const gh = fakeGithub();
    const checked = gh.tools.map((t) =>
      t.name === "github_get_pr"
        ? {
            ...t,
            checkCall: async (input: Record<string, unknown>) =>
              input.repo === "acme/secret"
                ? { ok: false as const, message: "Not allowed: acme/secret", data: { denied: "acme/secret" } }
                : { ok: true as const, data: { checkedRepo: input.repo } },
          }
        : t,
    );
    const tools = createToolGateway({ sources: [{ name: "checked", tools: async () => checked }] });
    const ctx = await ctxOf(f);
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    expect(
      await tools.invoke(ctx, { toolUseId: "tu_1", name: "github_get_pr", input: { repo: "acme/secret", pr: 1 } }),
    ).toEqual({
      type: "result",
      output: { content: "Not allowed: acme/secret", isError: true, data: { denied: "acme/secret" } },
    });
    expect(gh.executed).toEqual([]);
    expect(
      await tools.invoke(ctx, { toolUseId: "tu_2", name: "github_get_pr", input: { repo: "acme/app", pr: 2 } }),
    ).toMatchObject({
      output: { content: "github_get_pr ok: acme/app#2", data: { ok: true, checkedRepo: "acme/app" } },
    });
    // Merged with the connector-wide GitHub check's data (`repo`).
    const results = (await f.db.select().from(schema.agentRunSteps)).filter((s) => s.kind === "tool_result");
    expect(results.map((s) => (s.data as { data?: unknown }).data)).toEqual([
      { denied: "acme/secret" },
      { ok: true, repo: "acme/app", checkedRepo: "acme/app" },
    ]);
  });
});

describe("approval flow (end to end)", () => {
  const post = (fx: Fixture, body: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

  /** The model: reads the PR, asks to merge, then reports on what the tool said. */
  const script = (req: Parameters<NonNullable<Parameters<typeof setup>[0]>["reply"] & object>[0]) => {
    const last = req.messages.at(-1);
    const results =
      typeof last?.content === "string" ? [] : (last?.content ?? []).filter((b) => b.type === "tool_result");
    const said = (s: string) => results.some((r) => r.type === "tool_result" && r.content.includes(s));
    if (said("github_merge_pr ok")) return { chunks: ["Merge done."] };
    if (said("refused") || said("not executed")) return { chunks: ["Understood, I won't merge it."] };
    if (said("github_get_pr ok"))
      return {
        chunks: ["Tests pass, merging."],
        toolUses: [{ name: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }],
      };
    return {
      chunks: ["Let me look at the PR."],
      opaque: [{ type: "thinking", thinking: "", signature: "sig-1" }],
      toolUses: [{ name: "github_get_pr", input: { repo: "acme/app", pr: 42 } }],
    };
  };

  test("mention → tool call → approval → approve → resumed run → merged", async () => {
    const gh = fakeGithub();
    f = await setup({ toolSources: [gh.source], reply: script });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    const question = await post(f, "@dev merge PR 42 if the tests pass");
    await drainOutbox(f.db, f.handlers);

    let [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("waiting_approval");
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr"]);
    const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
    expect(approval).toMatchObject({ title: "Merge PR #42 in acme/app", canDecide: true, threadId: question.id });

    // The chat shows what the agent said before the approval and the card; earlier narration is a step.
    let thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
    expect(thread.map((m) => m.body)).toEqual([
      "@dev merge PR 42 if the tests pass",
      "Tests pass, merging.",
      "Approval request: Merge PR #42 in acme/app",
    ]);
    expect(thread[2]?.meta).toEqual({
      approvalId: approval?.id,
      bodyCode: "approval_request",
      bodyParams: { title: "Merge PR #42 in acme/app" },
    });
    expect(events.map((e) => e.type)).toContain("approval.created");
    expect([...events].reverse().find((e) => e.type === "agent.run")).toMatchObject({ status: "waiting_approval" });
    expect(events.at(-1)).toMatchObject({ type: "message.handled", status: "waiting_approval" });

    // A plain member can't decide.
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      decideApproval({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id, approval?.id ?? "", { decision: "approve" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(gh.executed).toEqual([
      { tool: "github_get_pr", input: { repo: "acme/app", pr: 42 } },
      { tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } },
    ]);
    thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
    expect(thread.at(-1)?.body).toBe("Merge done.");

    // The resumed call sent the same history (append-only, thinking block intact) plus the tool result.
    const calls = f.provider.calls.map((c) => c.request);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.messages.slice(0, calls[1]?.messages.length)).toEqual(calls[1]?.messages ?? []);
    expect(JSON.stringify(calls[2]?.messages)).toContain('"signature":"sig-1"');
    expect(calls[0]?.tools?.map((t) => t.name)).toEqual([
      "github_broken",
      "github_close_pr",
      "github_get_pr",
      "github_merge_pr",
    ]);
    const steps = (await f.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq))).map(
      (s) => s.kind,
    );
    expect(steps).toEqual([
      "context",
      "model_call",
      "tool_call",
      "tool_result",
      "model_call",
      "tool_call",
      "approval",
      "tool_result",
      "model_call",
      "message",
    ]);
    // Usage for all three model calls.
    expect(await f.db.select().from(schema.usageRecords)).toHaveLength(3);
    // Decided, then ran: the second event carries the result.
    const decidedEvents = events.filter((e) => e.type === "approval.decided");
    expect(decidedEvents).toHaveLength(2);
    expect(decidedEvents[1]).toMatchObject({ approval: { status: "approved", result: { ok: true } } });
    const [ran] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "decided" });
    expect(ran?.executedAt).not.toBeNull();
    expect(ran).toMatchObject({ why: "Tests pass, merging.", issue: null });
    const detail = await getApproval(f.db, f.owner.id, f.org.id, ran?.id ?? "");
    expect(detail.trail?.map((s) => s.text)).toEqual(["Let me look at the PR.", "Tests pass, merging."]);
  });

  test("refused: the model is told why, nothing is merged", async () => {
    const gh = fakeGithub();
    f = await setup({ toolSources: [gh.source], reply: script });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    const question = await post(f, "@dev merge PR 42");
    await drainOutbox(f.db, f.handlers);
    const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "refuse",
      reason: "freeze until Monday",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr"]);
    const last = f.provider.calls.at(-1)?.request.messages.at(-1);
    expect(textOf(last?.content ?? "")).toBe("");
    expect(JSON.stringify(last?.content)).toContain("Reason: freeze until Monday");
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
    expect(thread.at(-1)?.body).toBe("Understood, I won't merge it.");
    const [decided] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "decided" });
    expect(decided).toMatchObject({ status: "refused", reason: "freeze until Monday", decidedByUserId: f.owner.id });
    // A second decision is a conflict.
    await expect(
      decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", { decision: "approve" }),
    ).rejects.toThrow("already decided");
  });

  test("an approval left alone expires after 24 h and the run moves on", async () => {
    const gh = fakeGithub();
    f = await setup({ toolSources: [gh.source], reply: script });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    await post(f, "@dev merge PR 42");
    await drainOutbox(f.db, f.handlers);
    expect(await expireApprovals({ db: f.db, pubsub: f.pubsub })).toBe(0);
    expect(await expireApprovals({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 25 * 3600_000))).toBe(1);
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr"]);
    expect(JSON.stringify(f.provider.calls.at(-1)?.request.messages.at(-1))).toContain("within 24 hours");
  });

  test("the agent's owner (a plain member) may decide; admins see every approval", async () => {
    const gh = fakeGithub();
    f = await setup({ toolSources: [gh.source], reply: script });
    const owner = await addMember(f.db, f.org.id, "member", "joao");
    await f.db.update(schema.agents).set({ ownerUserId: owner.id }).where(eq(schema.agents.id, f.agent.id));
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    await post(f, "@dev merge PR 42");
    await drainOutbox(f.db, f.handlers);
    const [mine] = await listApprovals(f.db, owner.id, f.org.id, { status: "pending" });
    expect(mine?.canDecide).toBe(true);
    const stranger = await addMember(f.db, f.org.id, "member", "eve");
    expect(await listApprovals(f.db, stranger.id, f.org.id)).toEqual([]); // not in #general, not owner
    await decideApproval({ db: f.db, pubsub: f.pubsub }, owner.id, f.org.id, mine?.id ?? "", { decision: "approve" });
    await drainOutbox(f.db, f.handlers);
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr", "github_merge_pr"]);
  });

  test("tool loops are capped per run", async () => {
    const gh = fakeGithub();
    f = await setup({
      toolSources: [gh.source],
      reply: () => ({ chunks: [], toolUses: [{ name: "github_get_pr", input: { repo: "a/b", pr: 1 } }] }),
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    await post(f, "@dev loop forever");
    await drainOutbox(f.db, { ...f.handlers });
    const [run] = await f.db.select().from(schema.agentRuns);
    expect([run?.status, run?.error, run?.turns]).toEqual(["failed", "too_many_tool_calls", 25]);
  });
});
