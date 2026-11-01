import { PERMISSION_TOOL } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { auditsCall, callTitle, recordToolCall } from "../agent-audit";
import { coveringRules, type RememberedKind } from "../approval-rules";
import { type RunAuthority, runAuthorityById } from "../authority";
import { actionLevel, nameWords, openEnded } from "../connectors/classify";
import { missingConnectors, type ServerCatalog } from "../connectors/listing";
import { consultationOrigin } from "../consultations";
import { recordOutcome } from "../context/outcomes";
import { sha256 } from "../crypto";
import { cutText } from "../format";
import { addRunStep } from "../runs";
import {
  callTargets,
  checkTeamAction,
  commandAction,
  forgetPendingCommand,
  isOutsideTool,
  recordTeamAction,
  summarizeCall,
  type TeamCheck,
} from "../team-actions";
import { carriesCredential, promptAnswer, toolCommand, toolDetail } from "../tool-detail";
import { untrustedBlock } from "../untrusted";
import { checkToolCall } from "./checks";
import {
  type BlockedTool,
  compactSchema,
  directoryRole,
  ON_DEMAND_FIND,
  presentTools,
  resolveDirectoryTool,
} from "./directory";
import { canonicalJson, validateJson } from "./json-schema";
import { missingPermissions, REQUEST_PERMISSION_TOOL } from "./permission";
import { approvalOrigin, type PolicyDecision, takeWhy, toolKind, toolPolicy, WHY_REFUSAL, withWhy } from "./run-policy";
import {
  accessWithNeeds,
  BUILTIN_SCOPES,
  freshGrantedKeys,
  grantedScopeKeys,
  isAllowed,
  NOT_IN_ALL,
  toolAccess,
} from "./scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./types";

const { approvals, agents } = schema;
type AuditOutcome = schema.AuditOutcome;

/** Merge, deploy and rollback always need a person, whatever a connector says. */
export const ALWAYS_SENSITIVE = /(^|[^a-z])(merge|deploy|rollback|revert_deploy|promote)([^a-z]|$)/i;

export const isSensitive = (tool: Pick<ToolDefinition, "name" | "scope" | "sensitive">) =>
  tool.sensitive === true || ALWAYS_SENSITIVE.test(tool.name) || ALWAYS_SENSITIVE.test(tool.scope);

/**
 * Also as a noun or under another name: a deployment, a build, a dispatch or a release (they start workflows), a
 * branch's reference, an alias or a rolling release (production traffic), a re-run, a restore. Never approved for good.
 */
const NEVER_FOR_GOOD =
  /^(merge|deploy|redeploy|rollback|revert|restore|promote|workflow|build|dispatch|reference|release|alias|rolling|rerun|rerequest)/;
/**
 * Verbs right after the app that start what then runs on its own (`RAILWAY_COMMIT_ENVIRONMENT_CHANGES` deploys) or
 * run whatever their arguments say (`VERCEL_EXECUTE_SANDBOX_COMMAND`).
 */
const NEVER_LEADS = new Set(["commit", "trigger", "run", "execute", "invoke"]);
const alwaysAsks = (name: string) => {
  const words = nameWords(name);
  return (
    ALWAYS_SENSITIVE.test(name) ||
    openEnded(name) ||
    NEVER_LEADS.has(words[1] ?? "") ||
    words.some((w) => NEVER_FOR_GOOD.test(w))
  );
};

/**
 * The kind "Aprovar sempre" would cover for this call (`approval_rules`), or null when it is never offered: only
 * on a run that isn't a routine's, whose policy didn't make the call ask, for a tool its source lets be
 * remembered (`rememberAs`), whose wrapped actions, when it runs others, are a shape we know with none sensitive,
 * and with nothing in its names that always asks (merge, deploy, rollback and the rest above, GraphQL, SQL, a raw
 * request). A tool that names one exact target per call (`rememberTarget`) is remembered by that target, without
 * the name checks: they read connector actions, and a branch named release-x is still only that branch.
 */
export function rememberable(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  authority: RunAuthority | null,
  decision: PolicyDecision,
): RememberedKind | null {
  if (!authority || authority.kind === "routine" || decision.action === "approve") return null;
  if (tool.rememberTarget && tool.connectionId) {
    const target = tool.rememberTarget(input);
    return target ? { tool: tool.name, actions: [target] } : null;
  }
  if (!tool.rememberAs || !tool.connectionId) return null;
  const actions = tool.actions ? tool.actions(input) : [];
  if (!actions || actions.some((a) => actionLevel(a) === "sensitive")) return null;
  if ([tool.name, tool.rememberAs, tool.scope, ...actions].some(alwaysAsks)) return null;
  return { tool: tool.rememberAs, actions };
}

/** Hash an approval is bound to: tool, scope, connection and the exact parameters. */
export const actionHash = (action: {
  tool: string;
  scope: string;
  connectionId: string | null;
  params: Record<string, unknown>;
}) => sha256(canonicalJson(action));

export const APPROVAL_TTL_MS = 24 * 3600_000;
/** How much of a call's `describe().detail` an approval card keeps. */
export const APPROVAL_DETAIL_CHARS = 2000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_RESULT_CHARS = 50_000;
/** Server-owned Git tools have a connection ID only to use that connection's credential. */
const serverGitTool = (tool: ToolDefinition) =>
  (tool.name === "git_clone" && tool.scope === "github:git.read") ||
  (tool.name === "open_pull_request" && tool.scope === "github:pr.write") ||
  ((tool.name === "delete_branches" || tool.name === "request_branch_push") && tool.scope === "github:git.write");

/**
 * An `external` tool's output (an MCP server's answer) reaches the model inside the one envelope for
 * outside content (`untrustedBlock`): markers in it neutralised, so the text can't close the block
 * early. The result is already capped (`MAX_RESULT_CHARS`), so the envelope doesn't cut it again.
 */
export const wrapExternal = (source: string, text: string) => untrustedBlock(source, text, MAX_RESULT_CHARS + 100);
/** What run steps and approvals keep: the text people see, without the model's envelope. */
const shown = (text: string) =>
  cutText(text.replace(/^<external_data source="[^"]*">\n([\s\S]*)\n<\/external_data>$/, "$1"), 4000);

/**
 * An approved action already claimed (it runs at most once): what it returned, or, with nothing recorded
 * (it still runs elsewhere, or a restart or a dropped connection cut it), that it may not have finished.
 */
const ranBefore = (approval: { result: unknown }): ToolOutput =>
  (approval.result as ToolOutput | null) ?? {
    content:
      "This approved action was already started and its result isn't recorded: it may still be running, or it was cut off before finishing. Check its state before doing it again.",
    isError: true,
  };

/** The answer to a call of a routine's run that carries a credential (`carriesCredential`). */
export const CREDENTIAL_REFUSAL =
  "Refused: this call carries what looks like a key, token or private key. A routine's background work never sends credentials anywhere: leave the value out (you may say one was found, and where).";

/** `ask_user` (questions.ts): it waits for a person, so it carries a `why` like an approval. */
const ASK_USER = "ask_user";

const isBuiltIn = (tool: Pick<ToolDefinition, "scope" | "connectionId">) => tool.scope === "" && !tool.connectionId;

/** Whether a call of this tool waits for a person: an approval, or a built-in question. */
const asksPerson = (tool: ToolDefinition, decision: PolicyDecision) =>
  decision.action === "approve" || isSensitive(tool) || (tool.name === ASK_USER && isBuiltIn(tool));

/** A call that asks a person's approval because it says why (`whyAsks`: a command the computer held). */
const asksWithWhy = (tool: ToolDefinition, input: Record<string, unknown>) =>
  tool.whyAsks === true && input.why !== undefined;

/** A check that failed for any reason never stops the action (ADR 0064): it only misses a notice. */
const UNCHECKED: TeamCheck = { proceed: true, reason: null };

/** `permission_prompt`'s question (Claude Code and Codex commands): a new command, or the state of one asked. */
function promptQuestion(input: Record<string, unknown>) {
  if (typeof input.request_id === "string" && input.request_id) return { poll: input.request_id, action: null };
  const inner = input.input;
  const action =
    typeof input.tool_name === "string" && inner && typeof inner === "object" && !Array.isArray(inner)
      ? commandAction(input.tool_name, inner as Record<string, unknown>)
      : null;
  return { poll: null, action };
}

/**
 * A computer command's ending for the audit: allowed, refused, or waiting for a person. Asking again
 * about one still waiting is no new action (nothing to record).
 */
function promptOutcome(prompt: { poll: string | null }, output: ToolOutput): AuditOutcome | undefined {
  const answer = promptAnswer(output.content);
  if (answer.behavior === "allow") return "done";
  if (answer.behavior === "deny") return "refused";
  if (answer.status === "pending") return prompt.poll ? undefined : "pending";
  return output.isError ? "failed" : undefined;
}

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
 * The only way an agent's tool call runs (docs/adr/0015). For each call:
 * 1. the tool is looked up by name in the run's tool set (never trusting the
 *    model's claim of what it is);
 * 2. the agent's scope for it is read from `agent_scopes` (a prompt can't change it);
 * 3. the input is validated against the tool's JSON Schema;
 * 4. the run's policy (`run-policy.ts`: who is behind the run) refuses it,
 *    lets it run, or makes it ask a person;
 * 5. a call that asks a person (an approval, `ask_user`) must say why: the
 *    `why` is taken out of the input and kept on the approval or question;
 * 6. sensitive tools (and a `whyAsks` tool's call that says why) create an
 *    `approvals` row bound to the action hash and stop there, unless a rule
 *    someone approved for good covers the call ("Aprovar sempre",
 *    `approval_rules`); others run, with errors turned into error results. A
 *    tool that runs other actions (Composio's executor) is the connection's
 *    read when every action it runs only reads;
 * 7. `tool_call` / `tool_result` / `approval` steps are recorded;
 * 8. an outside call (a connected app's write, a command that leaves the
 *    computer) is held once when the team already did it to the same target,
 *    and recorded for the team once it went out (ADR 0064, `team-actions.ts`).
 */
export function createToolGateway(deps: {
  sources: ToolSource[];
  now?: () => Date;
  /** What this server can connect: `find_tools` names each connector a search asks for that the agent lacks. */
  catalog?: ServerCatalog;
}) {
  const now = deps.now ?? (() => new Date());

  async function allTools(ctx: ToolContext) {
    const byName = new Map<string, ToolDefinition>();
    for (const source of deps.sources) {
      for (const tool of await source.tools(ctx)) {
        if (!TOOL_NAME.test(tool.name)) continue;
        const current = byName.get(tool.name);
        // A connected MCP server must not shadow one of our own tools just
        // because its source appears earlier in the list.
        if (!current || (current.connectionId && (!tool.connectionId || serverGitTool(tool))))
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

  /** `known`: this call's `allTools`, when already read. */
  async function grantedFor(
    ctx: ToolContext,
    authority: RunAuthority | null,
    known?: Map<string, ToolDefinition>,
  ): Promise<ToolDefinition[]> {
    const [keys, all] = await Promise.all([grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId), known ?? allTools(ctx)]);
    return [...all.values()]
      .filter((t) => isAllowed(accessWithNeeds(keys, t).state))
      .flatMap((t) => {
        const decision = policyFor(authority, t);
        return decision.action === "refuse" ? [] : [asListed(t, decision)];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * What `find_tools` names as not allowed yet: every tool of this server's sources the agent may not use
   * (and the run could, once allowed), with each permission `request_permission` offers for it (its own,
   * and the one of a tool it `needs`), so the card can grant what the agent asks for; or none when an admin
   * turned that tool, or the one it needs, off by name. A tool with a permission `request_permission` doesn't
   * offer (a mailbox's or a database's, one more scope of a connector the agent already has some of) isn't named.
   */
  async function notAllowed(
    ctx: ToolContext,
    authority: RunAuthority | null,
    all: Map<string, ToolDefinition>,
  ): Promise<BlockedTool[]> {
    const [keys, missing] = await Promise.all([
      grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId),
      missingPermissions(ctx),
    ]);
    const offered = new Map(missing.map((m) => [m.id, m]));
    return [...all.values()].flatMap((tool): BlockedTool[] => {
      const own = toolAccess(keys, tool);
      const needs = tool.needs && { scope: tool.needs.scope, state: toolAccess(keys, tool.needs) };
      const lacks = [
        ...(isAllowed(own) ? [] : [tool.connectionId ? `connector:${tool.connectionId}` : tool.scope]),
        ...(needs && !isAllowed(needs.state) ? [needs.scope] : []),
      ];
      if (lacks.length === 0 || policyFor(authority, tool).action === "refuse") return [];
      if (own === "denied" || needs?.state === "denied") return [{ tool, permissions: null }];
      const asked = lacks.flatMap((id) => offered.get(id) ?? []);
      if (asked.length < lacks.length) return [];
      // The computer's scopes ("all tools" never covers them) say what they give, for the person approving.
      const permissions = asked.map((m) => {
        const plain = NOT_IN_ALL.has(m.scope) ? BUILTIN_SCOPES[m.scope]?.description : undefined;
        return { id: m.id, label: plain ? `${m.label}: ${plain}` : m.label };
      });
      return [{ tool, permissions }];
    });
  }

  /**
   * Tools this agent may call now, as the model sees them: each big
   * connector listed as its directory, and with tools on demand
   * (`ctx.loadedGroups`, ADR 0043) the groups not loaded behind `find_tools` /
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
          ? { ...output, content: `${cutText(output.content, MAX_RESULT_CHARS)}\n[truncated]` }
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
        const usable = await grantedFor(ctx, authority, all);
        const blocked = async () => {
          const [tools, connectors] = await Promise.all([
            notAllowed(ctx, authority, all).catch(() => []),
            deps.catalog
              ? missingConnectors(ctx.db, ctx.orgId, deps.catalog, { usable, listed: all.values() }).catch(() => [])
              : [],
          ]);
          const ask = usable.some((t) => t.name === REQUEST_PERMISSION_TOOL) ? REQUEST_PERMISSION_TOOL : null;
          return { tools, ask, connectors };
        };
        const listed = presentTools(usable, isSensitive, ctx.loadedGroups, blocked).find((t) => t.name === call.name);
        const role = directoryRole(listed);
        if (role?.kind === "find") directoryTool = listed;
        else if (role?.kind === "use") {
          const name = typeof call.input.tool === "string" ? call.input.tool : "";
          // `find_tools` also names tools the agent may not use: through its `use_tool` they run as a direct call
          // would, refused saying why. A big connector's search names only the tools the agent holds.
          const real = resolveDirectoryTool(role, name) ?? (role.prefix ? undefined : all.get(name.trim()));
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
      let tool = unknownInDirectory ? undefined : (all.get(call.name) ?? directoryTool);
      // What the live chip shows (the short label of a built-in tool, never a connector's input; the app and its
      // service): the chat's line of this call says the same after the run. A permission check also keeps its
      // command, masked, to open.
      const detail = toolDetail(call.name, call.input);
      const command = toolCommand(call.name, call.input);
      await record(ctx.db, step, "tool_call", {
        toolUseId: call.toolUseId,
        name: call.name,
        input: call.input,
        ...(detail ? { detail } : {}),
        ...(command ? { command } : {}),
        ...(tool?.connectorLabel ? { connector: tool.connectorLabel } : {}),
        ...(tool?.service ? { service: tool.service } : {}),
        ...(tool?.serviceIcon ? { serviceIcon: tool.serviceIcon } : {}),
      });
      /** The rules ("Aprovar sempre") this call ran under instead of asking. */
      let approvedBy: string[] | null = null;
      // The audit (agent-audit.ts): every call that matters, with how it ended. A routine's belongs where it
      // delivers, never to its room.
      const actionChannel =
        authority?.kind === "routine" ? (authority.brief?.deliverTo.channelId ?? ctx.channelId) : ctx.channelId;
      const audit = (
        outcome: AuditOutcome,
        extra: { reason?: string | null; approvalId?: string; secretRequestId?: string } = {},
      ) => {
        if (!tool) return Promise.resolve();
        const kind = toolKind(tool).kind;
        if (!auditsCall(kind, tool, outcome)) return Promise.resolve();
        return recordToolCall(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || null,
          channelId: actionChannel || null,
          authority,
          tool: tool.name,
          kind,
          connector: tool.connectorLabel ?? null,
          title: callTitle(tool, call.input),
          input: call.input,
          outcome,
          approvalRules: approvedBy,
          ...extra,
        });
      };
      /** `outcome`: what the audit says; none for a call that never really was one (a malformed input). */
      const finish = async (output: ToolOutput, outcome?: AuditOutcome) => {
        await record(ctx.db, step, "tool_result", {
          toolUseId: call.toolUseId,
          name: call.name,
          isError: output.isError === true,
          content: shown(output.content),
          ...(output.data ? { data: output.data } : {}),
        });
        if (outcome) await audit(outcome, outcome === "done" ? {} : { reason: shown(output.content) });
        return { type: "result" as const, output };
      };

      if (unknownInDirectory) return finish({ content: unknownInDirectory, isError: true });
      if (!tool) return finish({ content: `Unknown tool ${call.name}`, isError: true });
      // A tool that runs other actions (Composio's executor): a call whose actions all only read is the
      // connection's read, when the agent may read the connection. Everything below then sees a read.
      if (tool.actions && tool.readScope) {
        const bare = takeWhy(tool.inputSchema, call.input).input;
        const actions = tool.actions(bare);
        if (actions?.length && actions.every((a) => actionLevel(a) === "read")) {
          const read: ToolDefinition = { ...tool, scope: tool.readScope, sensitive: false };
          const keys = await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId);
          if (isAllowed(accessWithNeeds(keys, read).state)) {
            tool = read;
            call = { ...call, input: bare };
          }
        }
      }
      const builtIn = isBuiltIn(tool);
      const decision = policyFor(authority, tool);
      if (decision.action === "refuse") {
        return finish({ content: decision.reason, isError: true, data: { code: "tool.not_allowed" } }, "refused");
      }
      // A directory's search lists only tools the agent already holds; each real tool is checked on its own.
      if (tool !== directoryTool) {
        const access = accessWithNeeds(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool);
        if (!isAllowed(access.state)) {
          const reason =
            access.state === "denied"
              ? `${access.of === tool ? "this tool" : access.of.name} is turned off for this agent`
              : `this agent lacks the scope ${access.of.scope}. If the request needs it, ask for it with request_permission`;
          return finish({ content: `Not allowed: ${reason}`, isError: true }, "refused");
        }
      }
      // A call that asks a person says why (shown on its card); the tool itself never sees it. It is
      // asked for last: a call refused for any other reason (its input, a repository outside the agent's
      // list) gets that reason first.
      let approves = decision.action === "approve" || isSensitive(tool) || asksWithWhy(tool, call.input);
      let why = "";
      let whyMissing = false;
      if (asksPerson(tool, decision) || asksWithWhy(tool, call.input)) {
        const taken = takeWhy(tool.inputSchema, call.input);
        why = taken.why ?? "";
        whyMissing = !taken.why;
        call = { ...call, input: taken.input };
      }
      // Team actions (ADR 0064): an outside call repeated after the agent was told the team already did it
      // may say why (kept on the record); the tool never sees it.
      const outside = isOutsideTool(tool);
      let repeatWhy: string | null = null;
      const schemaProps = tool.inputSchema.properties as Record<string, unknown> | undefined;
      if (outside && !asksPerson(tool, decision) && "why" in call.input && schemaProps?.why === undefined) {
        const { why: given, ...rest } = call.input;
        repeatWhy = typeof given === "string" ? given : null;
        call = { ...call, input: rest };
      }
      const problems = validateJson(tool.inputSchema, call.input);
      if (problems.length > 0) {
        // Through a directory the model never saw the schema up front: show it, so the next call can be right.
        const schemaHint = viaDirectory ? `\nInput schema of ${tool.name}: ${compactSchema(tool.inputSchema)}` : "";
        return finish({ content: `Invalid input: ${problems.join("; ")}${schemaHint}`, isError: true });
      }
      // A routine's run never sends a credential anywhere (ADR 0053 §3): a key it read on its computer (a sandbox
      // that can't keep it from being read) can't leave through any tool, on any brain. Any other run uses the
      // agent's own grants, as a person's does.
      if (authority?.kind === "routine" && carriesCredential(call.input)) {
        return finish({ content: CREDENTIAL_REFUSAL, isError: true, data: { code: "tool.credential" } }, "refused");
      }
      // The call's arguments (GitHub repositories, mail folders and recipients…), before running or asking anyone.
      const check = await checkToolCall(tool, call.input, ctx);
      if (!check.ok) return finish({ content: check.message, isError: true, data: check.data ?? {} }, "refused");
      // "Aprovar sempre": a call of a kind someone approved for good runs like an allowed one, why or not.
      const remember = approves ? rememberable(tool, call.input, authority, decision) : null;
      if (remember && tool.connectionId) {
        const at = { orgId: ctx.orgId, agentId: ctx.agentId, connectionId: tool.connectionId };
        approvedBy = await coveringRules(ctx.db, at, remember);
        if (approvedBy) approves = false;
      }
      if (whyMissing && !approvedBy)
        return finish({ content: WHY_REFUSAL, isError: true, data: { code: "tool.why_missing" } });
      const withRepo = (output: ToolOutput): ToolOutput =>
        check.data ? { ...output, data: { ...output.data, ...check.data } } : output;

      // Team actions (ADR 0064): before acting outside, has the team already done this to the same target?
      const prompt = tool.name === PERMISSION_TOOL && builtIn ? promptQuestion(call.input) : null;
      const targets = outside ? callTargets(call.input) : (prompt?.action?.targets ?? []);
      let teamReason: string | null = null;
      if (outside || prompt?.action) {
        const seen = await checkTeamAction(ctx.db, ctx, {
          tool: prompt?.action?.tool ?? tool.name,
          targets,
          why: repeatWhy ?? (why || null),
        }).catch(() => UNCHECKED);
        if (!seen.proceed) {
          // A computer command is answered the way its prompt expects: a refusal with the notice.
          const content = prompt
            ? JSON.stringify({ behavior: "deny", message: seen.notice, code: "team" })
            : seen.notice;
          return finish({ content, isError: !prompt, data: { code: "team.action_seen" } }, "refused");
        }
        teamReason = seen.reason;
      }
      const recordAction = (input: {
        source: "tool" | "command";
        tool: string;
        summary: string;
        targets: string[];
        ref?: string;
      }) =>
        recordTeamAction(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || null,
          channelId: actionChannel || null,
          reason: teamReason,
          ...input,
        });

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
            detail: (described.detail ?? "").slice(0, APPROVAL_DETAIL_CHARS),
            why,
            origin: authority ? approvalOrigin(authority) : null,
            ownerUserId: owner,
            expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS),
            approveAlways: remember,
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
        await audit("pending", { reason: why || null, approvalId: row.id });
        return { type: "approval", approval: row };
      }
      const output = withRepo(await run(tool, call.input, { ...ctx, toolUseId: call.toolUseId }));
      if (outside && !output.isError) {
        await recordAction({
          source: "tool",
          tool: tool.name,
          summary: summarizeCall(tool, call.input),
          targets: callTargets(call.input, output.data),
        });
      }
      if (prompt) {
        const answer = promptAnswer(output.content);
        if (prompt.action && (answer.behavior === "allow" || answer.status === "pending")) {
          // A command waiting for a person counts already; it goes away if they say no.
          await recordAction({
            source: "command",
            tool: prompt.action.tool,
            summary: prompt.action.command,
            targets: prompt.action.targets,
            ...(answer.status === "pending" && answer.request_id ? { ref: answer.request_id } : {}),
          });
        }
        if (prompt.poll && answer.behavior === "deny") await forgetPendingCommand(ctx.db, ctx.orgId, prompt.poll);
      }
      if (builtIn && output.waitForAnswer?.text) {
        return { type: "question", text: output.waitForAnswer.text, choices: output.waitForAnswer.choices, why };
      }
      if (!tool.connectionId && output.waitForSecret?.requestId) {
        // The reader follows the request (delivered, declined, expired) from here.
        await audit("pending", { secretRequestId: output.waitForSecret.requestId });
        return { type: "secret", requestId: output.waitForSecret.requestId };
      }
      return finish(output, prompt ? promptOutcome(prompt, output) : output.isError ? "failed" : "done");
    },

    /**
     * Runs an approved action, exactly as hashed: the stored params, the same
     * tool and scope, at most once. Scope is re-checked (it may have been
     * revoked while waiting).
     */
    async executeApproved(ctx: ToolContext, approval: Approval): Promise<ToolOutput> {
      if (approval.status !== "approved") return { content: "This action was not approved", isError: true };
      if (approval.executedAt) return ranBefore(approval);
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
        const access = accessWithNeeds(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool);
        if (!isAllowed(access.state)) return `Not allowed: this agent lost the scope ${access.of.scope}`;
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
        if (claimed.length === 0) {
          const [row] = await ctx.db
            .select({ result: approvals.result })
            .from(approvals)
            .where(sql`${approvals.id} = ${approval.id}`);
          return ranBefore(row ?? approval);
        }
        output = await run(tool, approval.params, { ...ctx, toolUseId: approval.toolUseId, approved: true });
        // Team actions (ADR 0064): what a person approved and went out is the team's too.
        if (isOutsideTool(tool) && !output.isError) {
          await recordTeamAction(ctx.db, {
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            runId: ctx.runId || null,
            channelId: approval.channelId,
            source: "approval",
            tool: tool.name,
            summary: summarizeCall(tool, approval.params),
            targets: callTargets(approval.params, output.data),
          });
        }
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
      // The audit: the approved action ran (or couldn't any more). Who approved it is the approval's row.
      if (tool) {
        const kind = toolKind(tool).kind;
        const outcome: AuditOutcome = refused ? "refused" : output.isError ? "failed" : "done";
        if (auditsCall(kind, tool, outcome)) {
          await recordToolCall(ctx.db, {
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            runId: ctx.runId || null,
            channelId: approval.channelId,
            authority: await authorityOf(ctx).catch(() => null),
            tool: tool.name,
            kind,
            connector: tool.connectorLabel ?? null,
            title: approval.title,
            input: approval.params,
            outcome,
            reason: outcome === "done" ? null : shown(output.content),
            approvalId: approval.id,
          });
        }
      }
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
