import type { RunAuthority } from "../authority";
import { directoryRole } from "./directory";
import type { JsonSchema } from "./json-schema";
import type { ToolDefinition } from "./types";

/**
 * What a run may do with each tool, by who is behind it (ADR 0053 §2). One table for every brain:
 * the Tool Gateway applies it when listing (a refused tool isn't listed, for the model loop and for
 * the bridge Claude Code and Codex reach our tools through) and again on every call, and it turns
 * `approve` into an approval card whatever the agent's own settings say.
 *
 * - `person`: unchanged (scopes and the tools' own approvals decide).
 * - `routine`, any access: nothing that speaks for someone or reaches beyond its room (posting, DMs,
 *   reactions, questions, reminders, routines, other agents, forum, channels, secrets, permissions).
 *   It speaks only through `hand_off`; the people decide.
 * - `routine`, access `read`: reads only, plus `hand_off`.
 * - `routine`, access `act`: also internal changes people can undo (issues, memory, wiki, Drive, its
 *   own branches and pull requests, its computer); every write to a connected app asks a person.
 * - `unattended`: reads, the reply where it is (`react`, `pass`, questions, cards), issues, memory and
 *   Drive files with receipts; writes to a connected app ask a person; nothing elsewhere.
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
  /** Speaks in the run's own conversation (a reaction, a question, a card people act on). */
  | { kind: "here" }
  /** Speaks elsewhere or for someone: other channels, people, agents, routines, reminders, secrets. */
  | { kind: "elsewhere" }
  /** An internal change people can undo. */
  | { kind: "internal"; area: InternalArea }
  /** A write to a connected app (connector tools that aren't reads, mail). */
  | { kind: "external" }
  /** A tool this table doesn't know (no scope it reads): only for a person's run. */
  | { kind: "unknown" };

export type InternalArea = "issues" | "memory" | "drive" | "wiki" | "code" | "browser";

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
  "create_routine",
  "update_routine",
  "delete_routine",
  "run_routine_now",
  "open_forum_topic",
  "post_in_forum",
  "add_agent_to_channel",
  "request_secret",
  "request_permission",
  "request_folder_access",
  "propose_event",
]);

/** Speaks in the run's own conversation, by name. */
const HERE = new Set([
  "react",
  "ask_user",
  "share_artifact",
  "suggest_forum_topic",
  "propose_mission",
  "browser_ask_person",
  "update_thread",
]);

/** Reads under a scope that also writes, by name. */
const READS = new Set([
  "list_routines",
  "list_reminders",
  "read_forum_topic",
  "find_agent",
  "computer_status",
  "read_file",
  "list_files",
  "list_tasks",
  "task_status",
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
};

const isReadScope = (scope: string) => /[:.]read$/.test(scope);

/** What a tool does (see `ToolKind`): by name first, then its scope and whether it is a connector's. */
export function toolKind(tool: PolicyTool): ToolKind {
  if (directoryRole(tool as ToolDefinition)) return { kind: "directory" };
  if (tool.name === "hand_off") return { kind: "hand_off" };
  if (tool.name === "pass") return { kind: "pass" };
  if (ELSEWHERE.has(tool.name)) return { kind: "elsewhere" };
  if (HERE.has(tool.name)) return { kind: "here" };
  if (READS.has(tool.name)) return { kind: "read" };
  const named = INTERNAL_BY_NAME[tool.name];
  if (named) return { kind: "internal", area: named };
  // A connected app's tool (a catalog connector, a custom server, a mailbox, a database): a read when
  // its scope says so (`github:pr.read`, `custom:<id>:read`, `mail:read`, `database:read`), else a write.
  if (tool.connectionId) return isReadScope(tool.scope) && !tool.sensitive ? { kind: "read" } : { kind: "external" };
  if (isReadScope(tool.scope)) return { kind: "read" };
  const area = INTERNAL_BY_SCOPE[tool.scope];
  if (area) return { kind: "internal", area };
  // Anything else (a new tool without a scope this table knows): a sensitive one asks a person, like a
  // connected app's write; any other is only for a person's run.
  return tool.sensitive ? { kind: "external" } : { kind: "unknown" };
}

/** What unattended runs may change on their own: what carries a receipt and Undo, and files for their reply. */
const UNATTENDED_INTERNAL: ReadonlySet<InternalArea> = new Set(["issues", "memory", "drive"]);

export const REFUSALS = {
  routineElsewhere:
    "This is a routine's background work: it can't post, message people, ask or tell other agents, manage routines or reminders, or ask for secrets or permissions. Put it in hand_off; the people decide.",
  routineAskUser:
    "This is a routine's background work: nobody is here to answer. Decide with your best judgement; if a person must decide, say so in hand_off.",
  routineReact: "This is a routine's background work: there is no message to react to. Just finish, or use hand_off.",
  routineHere: "This is a routine's background work in a room nobody reads: put it in hand_off; the people decide.",
  routineReadOnly: "This routine only reads and reports: put what you'd do in hand_off; the people decide.",
  routineBrowserReadOnly:
    "This routine only reads and reports, and the browser can send data out: use your other tools, and say in hand_off what you'd check.",
  unattendedElsewhere:
    "Nobody asked for this work (a routine's report or another agent started it): you can't post elsewhere, message people, manage routines or reminders, ask or tell other agents, or ask for secrets or permissions. Say it in your reply here; the people decide.",
  unattendedInternal:
    "Nobody asked for this work (a routine's report or another agent started it): say in your reply what you'd do; a person asks you to go ahead.",
  handOffOnly: "Only background work (a routine's run) hands off: just reply.",
  unknownTool:
    "This tool is only for work a person asked for. Say what you'd do (in hand_off for a routine's work, in your reply otherwise); a person asks you to go ahead.",
} as const;

/** The table (see the file's comment): what `authority` may do with `tool`. */
export function toolPolicy(authority: RunAuthority, tool: PolicyTool): PolicyDecision {
  const what = toolKind(tool);
  if (what.kind === "directory" || what.kind === "pass") return ALLOW;
  if (authority.kind === "person") return what.kind === "hand_off" ? refuse(REFUSALS.handOffOnly) : ALLOW;
  if (authority.kind === "routine") {
    switch (what.kind) {
      case "hand_off":
      case "read":
        return ALLOW;
      case "elsewhere":
        return refuse(REFUSALS.routineElsewhere);
      case "here":
        return refuse(
          tool.name === "ask_user"
            ? REFUSALS.routineAskUser
            : tool.name === "react"
              ? REFUSALS.routineReact
              : REFUSALS.routineHere,
        );
      case "internal":
        if (authority.brief?.access === "act") return ALLOW;
        return refuse(what.area === "browser" ? REFUSALS.routineBrowserReadOnly : REFUSALS.routineReadOnly);
      case "external":
        return authority.brief?.access === "act" ? APPROVE : refuse(REFUSALS.routineReadOnly);
      case "unknown":
        return refuse(REFUSALS.unknownTool);
    }
  }
  switch (what.kind) {
    case "read":
    case "here":
      return ALLOW;
    case "hand_off":
      return refuse(REFUSALS.handOffOnly);
    case "elsewhere":
      return refuse(REFUSALS.unattendedElsewhere);
    case "internal":
      return UNATTENDED_INTERNAL.has(what.area) ? ALLOW : refuse(REFUSALS.unattendedInternal);
    case "external":
      return APPROVE;
    case "unknown":
      return refuse(REFUSALS.unknownTool);
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
    return { why: own.length >= WHY_MIN_CHARS ? own.slice(0, WHY_MAX_CHARS) : null, input };
  }
  const { why, ...rest } = input;
  const text = typeof why === "string" ? why.trim() : "";
  return { why: text.length >= WHY_MIN_CHARS ? text.slice(0, WHY_MAX_CHARS) : null, input: rest };
}
