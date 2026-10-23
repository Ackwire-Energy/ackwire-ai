import type { Database } from "@agenteschat/db";
import type { OutcomeKind } from "../context/outcomes";
import type { JsonSchema } from "./json-schema";

/** Who is calling a tool: always an agent inside a run. */
export interface ToolContext {
  db: Database;
  orgId: string;
  agentId: string;
  runId: string;
  channelId: string;
  threadRootId: string;
  triggerMessageId: string;
  /** The model's id of this tool call (set by the gateway): live output events refer to it. */
  toolUseId?: string;
  /** Aborted when a person cancels the run: long tools (running code) stop early. */
  signal?: AbortSignal;
  /**
   * The call came through the runner's `agentes` MCP bridge (ADR 0032): a
   * computer brain (Claude Code, Codex) on this machine. `taskId`: a mission
   * task's executor (its tools are the mission's, bound to that task). Tools
   * only for computer brains (`permission_prompt`) look at this.
   */
  bridge?: { machineId: string; taskId?: string };
  /**
   * Tools on demand (D65): the tool groups this run loaded (`Transcript.toolGroups`); the others sit
   * behind `find_tools` / `use_tool`. Undefined or null: every tool is listed as is.
   */
  loadedGroups?: readonly string[] | null;
  /**
   * A background run (`agent_runs.background`, a routine's): `hand_off` is offered to it. What it may
   * do is the run policy's (`run-policy.ts`), read from who is behind the run, never from this flag.
   */
  background?: boolean;
}

export interface ToolOutput {
  /** Text the model sees as the tool result. */
  content: string;
  isError?: boolean;
  /** Structured result kept in the run steps, not sent to the model. */
  data?: Record<string, unknown>;
  /** Ground truth this call produced (tests passed, PR merged…), recorded by the gateway. */
  outcome?: { kind: OutcomeKind; subject?: string; summary?: string; details?: Record<string, unknown> };
  /** Built-in `ask_user` only: suspend the run until a person answers this question (its `why` is the gateway's). */
  waitForAnswer?: { text: string; choices: string[] | null };
  /** `request_secret` only: suspend the run until the person answers this request (ADR 0027). */
  waitForSecret?: { requestId: string };
}

/**
 * A tool an agent can call, from any source (built-in, MCP connector,
 * sandbox). Every call goes through the Tool Gateway, which checks `scope`
 * against the agent's grants, validates the input against `inputSchema`, and
 * turns `sensitive` calls into approval requests.
 */
export interface ToolDefinition {
  /** Name shown to the model: `^[a-zA-Z0-9_-]{1,64}$`, unique within a run. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Scope the agent must hold, e.g. `context:read` or `github:pr.merge`.
   * Empty only for built-in tools every agent has (`ask_user`).
   */
  scope: string;
  /** Org connector connection the scope belongs to; null/undefined for built-in tools. */
  connectionId?: string | null;
  /** The app's name for connector tools ("GitHub", "himetrica"), for activity indicators. */
  connectorLabel?: string;
  /** Needs a person's approval for every call. Merge, deploy and rollback always do. */
  sensitive?: boolean;
  /**
   * The output is third-party content (an MCP server's answer: issues, pages,
   * messages anyone can write). The gateway hands it to the model inside an
   * `<external_data>` block so instructions in it read as data. Tools that
   * frame their own untrusted part (mail, databases, browser_read) leave it off.
   */
  external?: boolean;
  /** A mission's tool (agent mode, ADR 0029): its approvals are bound to that mission too. */
  missionId?: string;
  /** Human summary of a call, for approval cards. */
  describe?(input: Record<string, unknown>): { title: string; detail?: string };
  /**
   * Rules about this call's arguments (which folders, recipients, daily cap…),
   * run by the gateway after the scope check and schema validation, before
   * running or asking anyone, and again before an approved action runs.
   * Connector-wide rules (GitHub repositories) live in `tools/checks.ts`.
   */
  checkCall?(input: Record<string, unknown>, ctx: ToolContext): Promise<CallCheck>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Result of a per-call check. An allowed call's `data` is merged into the
 * tool result's data; a refusal's `message` is what the model sees and its
 * `data` is kept in the run step (e.g. `deniedRepo` for "Liberar").
 */
export type CallCheck =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; message: string; data?: Record<string, unknown> };

/** Supplies tools for a run. The gateway filters them by the agent's scopes. */
export interface ToolSource {
  readonly name: string;
  tools(ctx: ToolContext): Promise<ToolDefinition[]>;
}
