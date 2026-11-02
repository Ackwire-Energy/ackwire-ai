import { fedByRoutine, type RunAuthority } from "../authority";
import { cutText } from "../format";
import { directoryRole } from "./directory";
import type { JsonSchema } from "./json-schema";
import type { ToolDefinition } from "./types";

/**
 * What a run may do with each tool, by who is behind it (ADR 0053 §2 and its addendum of 2026-10-31). One
 * table for every brain: the Tool Gateway applies it when listing (a refused tool isn't listed, for the
 * model loop and for the bridge Claude Code and Codex reach our tools through) and again on every call,
 * and it turns `approve` into an approval card whatever the agent's own settings say.
 *
 * - `person` and `unattended` (nobody behind it: it works as the agent itself): every tool but
 *   `hand_off`; scopes and the tools' own approvals decide. A tool that needs a person's request
 *   refuses on its own when nobody is behind the run.
 * - `unattended` that a routine's report or work woke (`fedByRoutine`): what the routine read (inbound mail, a
 *   webhook) feeds it, so it keeps the routine's bounds (below), plus the reply where it is (`here`), never
 *   `hand_off` nor a mission's tools; every write to a connected app asks a person.
 * - `routine`: nothing that speaks for someone (reactions, GIFs and stickers, questions, reminders,
 *   routines, events, forum, channels, secrets, permissions). It reports through `hand_off`. Otherwise it
 *   works as the agent (ADR 0109: one permission model, the agent's own): reads, the web and the browser,
 *   internal changes people can undo (issues, memory, wiki, Drive, its own branches and pull requests, its
 *   computer); every write to a connected app asks a person. It reaches other agents (`ask_agent`,
 *   `tell_agent`) and posts where its creator can post (`post_message`, `send_dm` to its creator): the
 *   tools hold it to its creator's rooms and agents (ADR 0053 §2, amended 2026-10-31).
 *
 * Tool names are written here as plain strings (not imported) so the table loads before the tool
 * modules, which import the gateway.
 */
export type PolicyDecision = { action: "allow" } | { action: "approve" } | { action: "refuse"; reason: string };

/** What a tool does, as the table sees it. */
export type ToolKind =
  /** A directory's search or way in (`find_tools`, `use_tool`): the real tool is judged on its own. */
  | { kind: "directory" }
  /** Looks only. */
  | { kind: "read" }
  /** `hand_off`: a routine's report. */
  | { kind: "hand_off" }
  /** `pass`: ends the run without a message. */
  | { kind: "pass" }
  /** `set_status` (the agent's own line next to its name, ADR 0084) and `withdraw_request` (its own open requests): nothing else. */
  | { kind: "self" }
  /** Speaks in the run's own conversation (a reaction, a question, a card people act on). */
  | { kind: "here" }
  /** Speaks elsewhere or for someone: other channels, people, agents, routines, reminders, secrets. */
  | { kind: "elsewhere" }
  /** An internal change people can undo. */
  | { kind: "internal"; area: InternalArea }
  /** A write to a connected app (connector tools that aren't reads, mail). */
  | { kind: "external" }
  /**
   * The computer's own permission prompt (`permission_prompt`, Claude Code's `--permission-prompt-tool`):
   * what it allows is the command policy's, by the turn's profile. Every computer run needs it listed.
   */
  | { kind: "computer" }
  /** A mission's machine tools for its main session (`start_task`, `upload_artifact`): its own work only. */
  | { kind: "mission" }
  /** A tool this table doesn't know (no scope it reads): never a routine's. */
  | { kind: "unknown" };

export type InternalArea = "issues" | "memory" | "drive" | "wiki" | "code" | "browser" | "desktop";

export type PolicyTool = Pick<ToolDefinition, "name" | "scope" | "connectionId" | "sensitive">;

const ALLOW: PolicyDecision = { action: "allow" };
const APPROVE: PolicyDecision = { action: "approve" };
const refuse = (reason: string): PolicyDecision => ({ action: "refuse", reason });

/** Speaks for someone or beyond the run's conversation, by name. */
const ELSEWHERE = new Set([
  "post_message",
  "send_dm",
  "ask_agent",
  "tell_agent",
  "schedule_reminder",
  "cancel_reminder",
  "schedule_action",
  "create_routine",
  "update_routine",
  "delete_routine",
  "run_routine_now",
  "open_forum_topic",
  "post_in_forum",
  "add_agent_to_channel",
  "create_channel",
  "request_secret",
  "request_permission",
  "request_folder_access",
  "propose_event",
]);

/** What a routine may use of `ELSEWHERE`, by name. */
const ROUTINE_REACH = new Set(["post_message", "send_dm", "ask_agent", "tell_agent"]);

/** Speaks in the run's own conversation, by name. */
const HERE = new Set([
  "react",
  "send_gif",
  "send_sticker",
  "ask_user",
  "show_block",
  "start_poll",
  "share_artifact",
  "suggest_forum_topic",
  "propose_mission",
  "browser_ask_person",
  "desktop_ask_person",
  "update_thread",
  "offer_connect_ai",
  "propose_agent",
  "follow_up",
  "cancel_follow_up",
]);

/** Reads under a scope that also writes, by name. */
const READS = new Set([
  "list_routines",
  "list_reminders",
  "read_forum_topic",
  "find_agent",
  "get_my_usage",
  "computer_status",
  "read_file",
  "list_files",
  "list_tasks",
  "task_status",
  "get_context",
  "web_search",
  "web_fetch",
]);

/**
 * A mission's tools for its main session, by name: its machine tools (`mission-mcp.ts`) and its plan,
 * reports and delivery (`mission-tools.ts`, which also checks the run acts for the mission).
 */
const MISSION = new Set([
  "start_task",
  "upload_artifact",
  "update_plan",
  "record_findings",
  "report",
  "ask_decision",
  "request_review",
  "complete_mission",
  "request_approval",
]);

/** Internal changes outside their scope's own area, by name. */
const INTERNAL_BY_NAME: Readonly<Record<string, InternalArea>> = {
  git_clone: "code",
  open_pull_request: "code",
};

/** Built-in scopes of internal changes (`issues:write` → issues…). */
const INTERNAL_BY_SCOPE: Readonly<Record<string, InternalArea>> = {
  "issues:write": "issues",
  "memory:write": "memory",
  "drive:write": "drive",
  "wiki:write": "wiki",
  "sandbox:run": "code",
  "browser:use": "browser",
  "desktop:use": "desktop",
};

const isReadScope = (scope: string) => /[:.]read$/.test(scope);

/** What a tool does (see `ToolKind`): provenance first, then built-in name and scope. */
export function toolKind(tool: PolicyTool): ToolKind {
  if (directoryRole(tool as ToolDefinition)) return { kind: "directory" };
  // A way in like a directory's: the gateway runs the action approved ahead it names, judged as that action.
  if (tool.name === "run_approved_action" && !tool.connectionId && tool.scope === "") return { kind: "directory" };
  // These Git tools carry a connection ID for credentials, but they are our own
  // workspace-changing actions. Their exact scopes distinguish them from MCP tools.
  if (tool.name === "git_clone" && tool.scope === "github:git.read") return { kind: "internal", area: "code" };
  if (tool.name === "open_pull_request" && tool.scope === "github:pr.write") return { kind: "internal", area: "code" };
  // The computer's own background task (`sandbox-tools.ts`) is code work; the mission's `start_task` has no scope.
  if (tool.name === "start_task" && tool.scope === "sandbox:run") return { kind: "internal", area: "code" };
  // A connected app's tool (a catalog connector, custom server, mailbox, or database) is a read
  // only when its scope says so. Connector names can collide with built-ins (a custom MCP
  // server named "permission" exposing "prompt"). Classify by provenance
  // before consulting the built-in name table.
  if (tool.connectionId) return isReadScope(tool.scope) && !tool.sensitive ? { kind: "read" } : { kind: "external" };
  if (tool.name === "hand_off") return { kind: "hand_off" };
  if (tool.name === "pass") return { kind: "pass" };
  if (tool.name === "set_status" || tool.name === "withdraw_request") return { kind: "self" };
  if (tool.name === "permission_prompt") return { kind: "computer" };
  if (MISSION.has(tool.name)) return { kind: "mission" };
  if (ELSEWHERE.has(tool.name)) return { kind: "elsewhere" };
  if (HERE.has(tool.name)) return { kind: "here" };
  if (READS.has(tool.name)) return { kind: "read" };
  const named = INTERNAL_BY_NAME[tool.name];
  if (named) return { kind: "internal", area: named };
  if (isReadScope(tool.scope)) return { kind: "read" };
  const area = INTERNAL_BY_SCOPE[tool.scope];
  if (area) return { kind: "internal", area };
  // Anything else (a new tool without a scope this table knows): a sensitive one asks a person, like a
  // connected app's write; any other is never a routine's.
  return tool.sensitive ? { kind: "external" } : { kind: "unknown" };
}

export const REFUSALS = {
  routineElsewhere:
    "This is a routine's background work: it can't manage routines or reminders, propose events, open forum topics, change channels, or ask for secrets or permissions. Put it in hand_off; the people decide.",
  routineAskUser:
    "This is a routine's background work: nobody is here to answer. Decide with your best judgement; if a person must decide, say so in hand_off.",
  routineReact: "This is a routine's background work: there is no message to react to. Just finish, or use hand_off.",
  routineMedia:
    "This is a routine's background work: nobody is in its room to send a GIF or a sticker to. Just finish, or use hand_off.",
  routineHere: "This is a routine's background work in a room nobody reads: put it in hand_off; the people decide.",
  fedElsewhere:
    "A routine's report or work started this, so you keep within what that routine may do: you can't manage routines or reminders, propose events, open forum topics, change channels, ask for secrets or permissions, or use this tool. Say it in your reply here; the people decide.",
  fedMission:
    "A routine's report or work started this, not the mission: say in your reply what you'd do; the people decide.",
  handOffOnly: "Only background work (a routine's run) hands off: just reply.",
  missionOnly:
    "A routine's background work doesn't start a mission's tasks or upload its files: put what you'd do in hand_off; the people decide.",
  unknownTool: "A routine's background work can't use this tool: put what you'd do in hand_off; the people decide.",
} as const;

/** Tools that speak here whose refusal in a routine says what it does instead, by name; any other: `routineHere`. */
const ROUTINE_HERE_REFUSAL: Readonly<Record<string, string>> = {
  ask_user: REFUSALS.routineAskUser,
  react: REFUSALS.routineReact,
  send_gif: REFUSALS.routineMedia,
  send_sticker: REFUSALS.routineMedia,
};

/** The table (see the file's comment): what `authority` may do with `tool`. */
export function toolPolicy(authority: RunAuthority, tool: PolicyTool): PolicyDecision {
  const what = toolKind(tool);
  if (what.kind === "directory" || what.kind === "pass" || what.kind === "self" || what.kind === "computer") {
    return ALLOW;
  }
  // A person's run and a run nobody is behind work alike: as the agent, with every tool its scopes give.
  // The mission's own tools check that the run works for the mission (`runActsForMission`).
  const fed = authority.kind === "unattended" && fedByRoutine(authority);
  if (authority.kind !== "routine" && !fed) return what.kind === "hand_off" ? refuse(REFUSALS.handOffOnly) : ALLOW;
  // What a routine read feeds a run its report or work woke (`fedByRoutine`): that run keeps the routine's
  // bounds, replies where it is, and asks a person before writing to a connected app.
  switch (what.kind) {
    case "read":
      return ALLOW;
    case "hand_off":
      return fed ? refuse(REFUSALS.handOffOnly) : ALLOW;
    case "elsewhere":
      if (!ROUTINE_REACH.has(tool.name)) return refuse(fed ? REFUSALS.fedElsewhere : REFUSALS.routineElsewhere);
      return ALLOW;
    case "here":
      return fed ? ALLOW : refuse(ROUTINE_HERE_REFUSAL[tool.name] ?? REFUSALS.routineHere);
    case "internal":
      return ALLOW;
    case "external":
      return APPROVE;
    case "mission":
      return refuse(fed ? REFUSALS.fedMission : REFUSALS.missionOnly);
    case "unknown":
      return refuse(fed ? REFUSALS.fedElsewhere : REFUSALS.unknownTool);
  }
}

/** Where an approval asked while nobody watched comes from (`approvals.origin`): the card and notification say so. */
export type ApprovalOrigin = { kind: "routine"; routineId: string; routineName: string } | { kind: "unattended" };

/** Approvals asked while nobody watched say so (`approvals.origin`); null when a person was behind the run. */
export function approvalOrigin(authority: RunAuthority): ApprovalOrigin | null {
  if (authority.kind === "person") return null;
  if (authority.kind === "routine" && authority.brief) {
    return { kind: "routine", routineId: authority.brief.routineId, routineName: authority.brief.name };
  }
  return { kind: "unattended" };
}

// ── The required reason ("why") ──────────────────────────────────────────────

/** The reason every request for a person (an approval, `ask_user`) carries, at least this long. */
export const WHY_MIN_CHARS = 40;
export const WHY_MAX_CHARS = 1000;
export const WHY_REFUSAL = "Say why first: what you found and why this action; people see it on the card.";

const WHY_PROPERTY: JsonSchema = {
  type: "string",
  minLength: WHY_MIN_CHARS,
  maxLength: WHY_MAX_CHARS,
  description:
    "Why you ask, for the people deciding (shown on the card): what you found and why this action, in their language.",
};

/** Whether a tool's own schema already has a `why` (then it is the tool's, never stripped). */
const ownsWhy = (schema: JsonSchema) =>
  typeof schema.properties === "object" && schema.properties !== null && "why" in schema.properties;

/** A tool's input schema with the required `why` added (as is when the tool has its own). */
export function withWhy(schema: JsonSchema): JsonSchema {
  if (ownsWhy(schema)) return schema;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => r !== "why") : [];
  return {
    ...schema,
    type: "object",
    properties: { ...properties, why: WHY_PROPERTY },
    required: [...required, "why"],
  };
}

/**
 * Takes the `why` out of a call's input (the tool itself never sees it): the reason, or null when it
 * is missing or too short, and the input to validate and run. A tool with its own `why` keeps it.
 */
export function takeWhy(
  schema: JsonSchema,
  input: Record<string, unknown>,
): { why: string | null; input: Record<string, unknown> } {
  if (ownsWhy(schema)) {
    const own = typeof input.why === "string" ? input.why.trim() : "";
    return { why: own.length >= WHY_MIN_CHARS ? cutText(own, WHY_MAX_CHARS) : null, input };
  }
  const { why, ...rest } = input;
  const text = typeof why === "string" ? why.trim() : "";
  return { why: text.length >= WHY_MIN_CHARS ? cutText(text, WHY_MAX_CHARS) : null, input: rest };
}
