import { and, eq, schema, sql } from "@agenteschat/db";
import { type RunAuthority, runAuthorityById } from "../authority";
import { consultationOrigin } from "../consultations";
import { recordOutcome } from "../context/outcomes";
import { sha256 } from "../crypto";
import { addRunStep } from "../runs";
import { carriesCredential } from "../tool-detail";
import { untrustedBlock } from "../untrusted";
import { checkToolCall } from "./checks";
import { compactSchema, directoryRole, ON_DEMAND_FIND, presentTools, resolveDirectoryTool } from "./directory";
import { canonicalJson, validateJson } from "./json-schema";
import { approvalOrigin, type PolicyDecision, takeWhy, toolPolicy, WHY_REFUSAL, withWhy } from "./run-policy";
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

/**
 * An `external` tool's output (an MCP server's answer) reaches the model inside the one envelope for
 * outside content (`untrustedBlock`): markers in it neutralised, so the text can't close the block
 * early. The result is already capped (`MAX_RESULT_CHARS`), so the envelope doesn't cut it again.
 */
export const wrapExternal = (source: string, text: string) => untrustedBlock(source, text, MAX_RESULT_CHARS + 100);
/** What run steps and approvals keep: the text people see, without the model's envelope. */
const shown = (text: string) =>
  text.replace(/^<external_data source="[^"]*">\n([\s\S]*)\n<\/external_data>$/, "$1").slice(0, 4000);

/** The answer to a call of a run nobody is behind that carries a credential (`carriesCredential`). */
export const CREDENTIAL_REFUSAL =
  "Refused: this call carries what looks like a key, token or private key. Work no person asked for never sends credentials anywhere: leave the value out (you may say one was found, and where).";

/** `ask_user` (questions.ts): it waits for a person, so it carries a `why` like an approval. */
const ASK_USER = "ask_user";

const isBuiltIn = (tool: Pick<ToolDefinition, "scope" | "connectionId">) => tool.scope === "" && !tool.connectionId;

/** Whether a call of this tool waits for a person: an approval, or a built-in question. */
const asksPerson = (tool: ToolDefinition, decision: PolicyDecision) =>
  decision.action === "approve" || isSensitive(tool) || (tool.name === ASK_USER && isBuiltIn(tool));

/** Who is behind the call's run (ADR 0053). Null for a mission task's call: no run, the mission's own gates. */
const authorityOf = (ctx: ToolContext): Promise<RunAuthority | null> =>
  ctx.runId ? runAuthorityById(ctx.db, ctx.orgId, ctx.runId) : Promise.resolve(null);

const ALLOWED: PolicyDecision = { action: "allow" };
const policyFor = (authority: RunAuthority | null, tool: ToolDefinition) =>
  authority ? toolPolicy(authority, tool) : ALLOWED;

/**
 * A tool as a run sees it: one the policy says asks a person becomes sensitive (its card, and the
 * "asks a person's approval" in a directory), and every tool that asks a person takes the required
 * `why` the card shows. The same list goes to the model loop and to the bridge.
 */
function asListed(tool: ToolDefinition, decision: PolicyDecision): ToolDefinition {
  if (!asksPerson(tool, decision)) return tool;
  return {
    ...tool,
    ...(decision.action === "approve" ? { sensitive: true } : {}),
    inputSchema: withWhy(tool.inputSchema),
  };
}

export type ToolCall = { toolUseId: string; name: string; input: Record<string, unknown> };
export type Approval = typeof approvals.$inferSelect;

export type InvokeResult =
  | { type: "result"; output: ToolOutput }
  | { type: "approval"; approval: Approval }
  /** `ask_user`: the executor posts the question and suspends the run. */
  | { type: "question"; text: string; choices: string[] | null; why: string }
  /** `request_secret`: the executor posts the card and suspends the run. */
  | { type: "secret"; requestId: string };

/**
 * The only way an agent's tool call runs (D2, docs/adr/0015). For each call:
 * 1. the tool is looked up by name in the run's tool set (never trusting the
 *    model's claim of what it is);
 * 2. the agent's scope for it is read from `agent_scopes` (a prompt can't change it);
 * 3. the input is validated against the tool's JSON Schema;
 * 4. the run's policy (`run-policy.ts`: who is behind the run) refuses it,
 *    lets it run, or makes it ask a person;
 * 5. a call that asks a person (an approval, `ask_user`) must say why: the
 *    `why` is taken out of the input and kept on the approval or question;
 * 6. sensitive tools create an `approvals` row bound to the action hash and
 *    stop there; others run, with errors turned into error results;
 * 7. `tool_call` / `tool_result` / `approval` steps are recorded.
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

  /**
   * Every tool this agent may call now: every source, filtered by granted scopes and by the run's
   * policy (a refused tool isn't listed), by name. Tools that ask a person carry the required `why`.
   */
  async function granted(ctx: ToolContext): Promise<ToolDefinition[]> {
    return grantedFor(ctx, await authorityOf(ctx));
  }

  async function grantedFor(ctx: ToolContext, authority: RunAuthority | null): Promise<ToolDefinition[]> {
    const [keys, all] = await Promise.all([grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId), allTools(ctx)]);
    return [...all.values()]
      .filter((t) => isAllowed(toolAccess(keys, t)))
      .flatMap((t) => {
        const decision = policyFor(authority, t);
        return decision.action === "refuse" ? [] : [asListed(t, decision)];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Tools this agent may call now, as the model sees them: each big
   * connector listed as its directory, and with tools on demand
   * (`ctx.loadedGroups`, D65) the groups not loaded behind `find_tools` /
   * `use_tool` (tools/directory.ts).
   */
  async function list(ctx: ToolContext): Promise<ToolDefinition[]> {
    return presentTools(await granted(ctx), isSensitive, ctx.loadedGroups);
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
      const capped =
        output.content.length > MAX_RESULT_CHARS
          ? { ...output, content: `${output.content.slice(0, MAX_RESULT_CHARS)}\n[truncated]` }
          : output;
      return tool.external ? { ...capped, content: wrapExternal(tool.name, capped.content) } : capped;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An MCP server's error text is its own words too.
      return { content: `Tool failed: ${tool.external ? wrapExternal(tool.name, message) : message}`, isError: true };
    }
  }

  return {
    list,
    granted,

    async invoke(ctx: ToolContext, requested: ToolCall): Promise<InvokeResult> {
      // Who is behind the run decides what it may do: listing already hid refused tools, this is the call.
      const [all, authority] = await Promise.all([allTools(ctx), authorityOf(ctx)]);
      // A big connector's directory (tools/directory.ts): `use_tool` runs the real tool by its own name, so
      // everything below (steps, policy, scope, schema, checks, approval) is that tool's; `find_tools` runs as is.
      let call = requested;
      let directoryTool: ToolDefinition | undefined;
      let unknownInDirectory: string | null = null;
      if (!all.has(call.name)) {
        const listed = presentTools(await grantedFor(ctx, authority), isSensitive, ctx.loadedGroups).find(
          (t) => t.name === call.name,
        );
        const role = directoryRole(listed);
        if (role?.kind === "find") directoryTool = listed;
        else if (role?.kind === "use") {
          const name = typeof call.input.tool === "string" ? call.input.tool : "";
          const real = resolveDirectoryTool(role, name);
          const args = call.input.arguments;
          if (real) {
            call = {
              ...call,
              name: real.name,
              input: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
            };
          } else {
            const find = role.prefix ? `${role.prefix}_find_tools` : ON_DEMAND_FIND;
            unknownInDirectory = `No ${role.label} tool named "${name}". Find the exact name with ${find}.`;
          }
        }
      }
      const viaDirectory = call !== requested;
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
          content: shown(output.content),
          ...(output.data ? { data: output.data } : {}),
        });
        return { type: "result" as const, output };
      };

      if (unknownInDirectory) return finish({ content: unknownInDirectory, isError: true });
      const tool = all.get(call.name) ?? directoryTool;
      if (!tool) return finish({ content: `Unknown tool ${call.name}`, isError: true });
      const builtIn = isBuiltIn(tool);
      const decision = policyFor(authority, tool);
      if (decision.action === "refuse") {
        return finish({ content: decision.reason, isError: true, data: { code: "tool.not_allowed" } });
      }
      // A directory's search lists only tools the agent already holds; each real tool is checked on its own.
      if (tool !== directoryTool) {
        const access = toolAccess(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool);
        if (!isAllowed(access)) {
          const reason =
            access === "denied"
              ? "this tool is turned off for this agent"
              : `this agent lacks the scope ${tool.scope}. If the request needs it, ask for it with request_permission`;
          return finish({ content: `Not allowed: ${reason}`, isError: true });
        }
      }
      // A call that asks a person says why (shown on its card); the tool itself never sees it. It is
      // asked for last: a call refused for any other reason (its input, a repository outside the agent's
      // list) gets that reason first.
      const approves = decision.action === "approve" || isSensitive(tool);
      let why = "";
      let whyMissing = false;
      if (asksPerson(tool, decision)) {
        const taken = takeWhy(tool.inputSchema, call.input);
        why = taken.why ?? "";
        whyMissing = !taken.why;
        call = { ...call, input: taken.input };
      }
      const problems = validateJson(tool.inputSchema, call.input);
      if (problems.length > 0) {
        // Through a directory the model never saw the schema up front: show it, so the next call can be right.
        const schemaHint = viaDirectory ? `\nInput schema of ${tool.name}: ${compactSchema(tool.inputSchema)}` : "";
        return finish({ content: `Invalid input: ${problems.join("; ")}${schemaHint}`, isError: true });
      }
      // A run nobody is behind never sends a credential anywhere (ADR 0053 §3): a key it read on its computer
      // (a sandbox that can't keep it from being read) can't leave through any tool, on any brain.
      if (authority && authority.kind !== "person" && carriesCredential(call.input)) {
        return finish({ content: CREDENTIAL_REFUSAL, isError: true, data: { code: "tool.credential" } });
      }
      // The call's arguments (GitHub repositories, mail folders and recipients…), before running or asking anyone.
      const check = await checkToolCall(tool, call.input, ctx);
      if (!check.ok) return finish({ content: check.message, isError: true, data: check.data ?? {} });
      if (whyMissing) return finish({ content: WHY_REFUSAL, isError: true, data: { code: "tool.why_missing" } });
      const withRepo = (output: ToolOutput): ToolOutput =>
        check.data ? { ...output, data: { ...output.data, ...check.data } } : output;

      if (approves) {
        const owner = await ownerOf(ctx);
        // A routine's request goes to the conversation it reports to, never its room; one asked by another
        // agent (ADR 0034) where the person is, not in the agents' DM.
        const deliverTo = authority?.kind === "routine" ? authority.brief?.deliverTo : undefined;
        const origin = deliverTo
          ? { channelId: deliverTo.channelId, threadRootId: deliverTo.threadId ?? ctx.threadRootId }
          : ctx.runId
            ? await consultationOrigin(ctx.db, ctx.orgId, ctx.runId)
            : null;
        const described = tool.describe?.(call.input) ?? { title: `${tool.name}`, detail: canonicalJson(call.input) };
        const connectionId = tool.connectionId ?? null;
        const [approval] = await ctx.db
          .insert(approvals)
          .values({
            orgId: ctx.orgId,
            runId: ctx.runId,
            missionId: tool.missionId ?? null,
            agentId: ctx.agentId,
            channelId: origin?.channelId ?? ctx.channelId,
            threadRootId: origin?.threadRootId ?? ctx.threadRootId,
            toolUseId: call.toolUseId,
            tool: tool.name,
            scope: tool.scope,
            connectionId,
            params: call.input,
            actionHash: actionHash({ tool: tool.name, scope: tool.scope, connectionId, params: call.input }),
            title: described.title.slice(0, 300),
            detail: (described.detail ?? "").slice(0, 2000),
            why,
            origin: authority ? approvalOrigin(authority) : null,
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
      const output = withRepo(await run(tool, call.input, { ...ctx, toolUseId: call.toolUseId }));
      if (builtIn && output.waitForAnswer?.text) {
        return { type: "question", text: output.waitForAnswer.text, choices: output.waitForAnswer.choices, why };
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
      // Why the approved action can't run any more; null = it may.
      const refusal = async (): Promise<string | null> => {
        if (expected !== approval.actionHash) return "Approval does not match the action";
        if (!tool || tool.scope !== approval.scope || (tool.connectionId ?? null) !== approval.connectionId)
          return `The tool ${approval.tool} is no longer available`;
        if (!isAllowed(toolAccess(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool)))
          return `Not allowed: this agent lost the scope ${tool.scope}`;
        // Rules about the arguments again: a repository or recipient may have been removed while waiting.
        const check = await checkToolCall(tool, approval.params, ctx);
        return check.ok ? null : check.message;
      };
      let output: ToolOutput;
      const refused = await refusal();
      if (refused || !tool) output = { content: refused ?? "Not allowed", isError: true };
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
        .set({ result: { content: shown(output.content), isError: output.isError === true } })
        .where(sql`${approvals.id} = ${approval.id}`);
      await addRunStep(ctx.db, { id: ctx.runId, orgId: ctx.orgId }, "tool_result", {
        toolUseId: approval.toolUseId,
        name: approval.tool,
        approvalId: approval.id,
        isError: output.isError === true,
        content: shown(output.content),
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
