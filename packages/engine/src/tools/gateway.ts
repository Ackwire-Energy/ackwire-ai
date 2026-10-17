import { and, eq, schema, sql } from "@agenteschat/db";
import { recordOutcome } from "../context/outcomes";
import { sha256 } from "../crypto";
import { addRunStep } from "../runs";
import { canonicalJson, validateJson } from "./json-schema";
import { freshGrantedKeys, grantedScopeKeys, isAllowed, toolAccess } from "./scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./types";

const { approvals, agents } = schema;

/** Merge, deploy and rollback always need a person, whatever a connector says. */
export const ALWAYS_SENSITIVE = /(^|[^a-z])(merge|deploy|rollback|revert_deploy|promote)([^a-z]|$)/i;

export const isSensitive = (tool: Pick<ToolDefinition, "name" | "scope" | "sensitive">) =>
  tool.sensitive === true || ALWAYS_SENSITIVE.test(tool.name) || ALWAYS_SENSITIVE.test(tool.scope);

/** Hash an approval is bound to: tool, scope, connection and the exact parameters. */
export const actionHash = (action: {
  tool: string;
  scope: string;
  connectionId: string | null;
  params: Record<string, unknown>;
}) => sha256(canonicalJson(action));

export const APPROVAL_TTL_MS = 24 * 3600_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_RESULT_CHARS = 50_000;

export type ToolCall = { toolUseId: string; name: string; input: Record<string, unknown> };
export type Approval = typeof approvals.$inferSelect;

export type InvokeResult =
  | { type: "result"; output: ToolOutput }
  | { type: "approval"; approval: Approval }
  /** `ask_user`: the executor posts the question and suspends the run. */
  | { type: "question"; text: string; choices: string[] | null }
  /** `request_secret`: the executor posts the card and suspends the run. */
  | { type: "secret"; requestId: string };

/**
 * The only way an agent's tool call runs (D2, docs/adr/0015). For each call:
 * 1. the tool is looked up by name in the run's tool set (never trusting the
 *    model's claim of what it is);
 * 2. the agent's scope for it is read from `agent_scopes` (a prompt can't change it);
 * 3. the input is validated against the tool's JSON Schema;
 * 4. sensitive tools create an `approvals` row bound to the action hash and
 *    stop there; others run, with errors turned into error results;
 * 5. `tool_call` / `tool_result` / `approval` steps are recorded.
 */
export function createToolGateway(deps: { sources: ToolSource[]; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  async function allTools(ctx: ToolContext) {
    const byName = new Map<string, ToolDefinition>();
    for (const source of deps.sources) {
      for (const tool of await source.tools(ctx)) {
        if (!TOOL_NAME.test(tool.name) || byName.has(tool.name)) continue;
        byName.set(tool.name, tool);
      }
    }
    return byName;
  }

  /** Tools this agent may call now: every source, filtered by granted scopes. */
  async function list(ctx: ToolContext): Promise<ToolDefinition[]> {
    const granted = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
    return [...(await allTools(ctx)).values()]
      .filter((t) => isAllowed(toolAccess(granted, t)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function run(tool: ToolDefinition, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    try {
      const output = await tool.execute(input, ctx);
      if (output.outcome) {
        await recordOutcome(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          channelId: ctx.channelId,
          threadRootId: ctx.threadRootId,
          source: "tool",
          ...output.outcome,
        }).catch(() => {});
      }
      return output.content.length > MAX_RESULT_CHARS
        ? { ...output, content: `${output.content.slice(0, MAX_RESULT_CHARS)}\n[truncated]` }
        : output;
    } catch (error) {
      return { content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }

  return {
    list,

    async invoke(ctx: ToolContext, call: ToolCall): Promise<InvokeResult> {
      const step = { id: ctx.runId, orgId: ctx.orgId };
      // A mission task's call through the bridge has no run (ADR 0032): nothing to record steps on.
      const record: typeof addRunStep = (db, run, kind, data) =>
        ctx.runId ? addRunStep(db, run, kind, data) : Promise.resolve();
      await record(ctx.db, step, "tool_call", { toolUseId: call.toolUseId, name: call.name, input: call.input });
      const finish = async (output: ToolOutput) => {
        await record(ctx.db, step, "tool_result", {
          toolUseId: call.toolUseId,
          name: call.name,
          isError: output.isError === true,
          content: output.content.slice(0, 4000),
          ...(output.data ? { data: output.data } : {}),
        });
        return { type: "result" as const, output };
      };

      const tool = (await allTools(ctx)).get(call.name);
      if (!tool) return finish({ content: `Unknown tool ${call.name}`, isError: true });
      const builtIn = tool.scope === "" && !tool.connectionId;
      const access = toolAccess(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool);
      if (!isAllowed(access)) {
        const reason =
          access === "denied" ? "this tool is turned off for this agent" : `this agent lacks the scope ${tool.scope}`;
        return finish({ content: `Not allowed: ${reason}`, isError: true });
      }
      const problems = validateJson(tool.inputSchema, call.input);
      if (problems.length > 0) return finish({ content: `Invalid input: ${problems.join("; ")}`, isError: true });

      if (isSensitive(tool)) {
        const owner = await ownerOf(ctx);
        const described = tool.describe?.(call.input) ?? { title: `${tool.name}`, detail: canonicalJson(call.input) };
        const connectionId = tool.connectionId ?? null;
        const [approval] = await ctx.db
          .insert(approvals)
          .values({
            orgId: ctx.orgId,
            runId: ctx.runId,
            missionId: tool.missionId ?? null,
            agentId: ctx.agentId,
            channelId: ctx.channelId,
            threadRootId: ctx.threadRootId,
            toolUseId: call.toolUseId,
            tool: tool.name,
            scope: tool.scope,
            connectionId,
            params: call.input,
            actionHash: actionHash({ tool: tool.name, scope: tool.scope, connectionId, params: call.input }),
            title: described.title.slice(0, 300),
            detail: (described.detail ?? "").slice(0, 2000),
            ownerUserId: owner,
            expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS),
          })
          .onConflictDoNothing()
          .returning();
        const row =
          approval ??
          (
            await ctx.db
              .select()
              .from(approvals)
              .where(and(eq(approvals.runId, ctx.runId), eq(approvals.toolUseId, call.toolUseId)))
          )[0];
        if (!row) throw new Error("approval insert returned nothing");
        await record(ctx.db, step, "approval", { approvalId: row.id, toolUseId: call.toolUseId, title: row.title });
        return { type: "approval", approval: row };
      }
      const output = await run(tool, call.input, { ...ctx, toolUseId: call.toolUseId });
      if (builtIn && output.waitForAnswer?.text) {
        return { type: "question", text: output.waitForAnswer.text, choices: output.waitForAnswer.choices };
      }
      if (!tool.connectionId && output.waitForSecret?.requestId) {
        return { type: "secret", requestId: output.waitForSecret.requestId };
      }
      return finish(output);
    },

    /**
     * Runs an approved action, exactly as hashed: the stored params, the same
     * tool and scope, at most once. Scope is re-checked (it may have been
     * revoked while waiting).
     */
    async executeApproved(ctx: ToolContext, approval: Approval): Promise<ToolOutput> {
      if (approval.status !== "approved") return { content: "This action was not approved", isError: true };
      if (approval.executedAt) {
        return (approval.result as ToolOutput | null) ?? { content: "Already executed", isError: false };
      }
      const expected = actionHash({
        tool: approval.tool,
        scope: approval.scope,
        connectionId: approval.connectionId,
        params: approval.params,
      });
      const tool = (await allTools(ctx)).get(approval.tool);
      let output: ToolOutput;
      if (expected !== approval.actionHash) output = { content: "Approval does not match the action", isError: true };
      else if (!tool || tool.scope !== approval.scope || (tool.connectionId ?? null) !== approval.connectionId)
        output = { content: `The tool ${approval.tool} is no longer available`, isError: true };
      else if (!isAllowed(toolAccess(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool)))
        output = { content: `Not allowed: this agent lost the scope ${tool.scope}`, isError: true };
      else {
        // Claim the execution first: a retried job never runs the action twice.
        const claimed = await ctx.db
          .update(approvals)
          .set({ executedAt: now() })
          .where(sql`${approvals.id} = ${approval.id} and ${approvals.executedAt} is null`)
          .returning({ id: approvals.id });
        if (claimed.length === 0) return { content: "Already executed", isError: false };
        output = await run(tool, approval.params, { ...ctx, toolUseId: approval.toolUseId });
      }
      await ctx.db
        .update(approvals)
        .set({ result: { content: output.content.slice(0, 4000), isError: output.isError === true } })
        .where(sql`${approvals.id} = ${approval.id}`);
      await addRunStep(ctx.db, { id: ctx.runId, orgId: ctx.orgId }, "tool_result", {
        toolUseId: approval.toolUseId,
        name: approval.tool,
        approvalId: approval.id,
        isError: output.isError === true,
        content: output.content.slice(0, 4000),
        ...(output.data ? { data: output.data } : {}),
      });
      return output;
    },
  };

  async function ownerOf(ctx: ToolContext) {
    const rows = await ctx.db
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(sql`${agents.id} = ${ctx.agentId} and ${agents.orgId} = ${ctx.orgId}`);
    return rows[0]?.ownerUserId ?? null;
  }
}

export type ToolGateway = ReturnType<typeof createToolGateway>;
