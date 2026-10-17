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
}

export interface ToolOutput {
  /** Text the model sees as the tool result. */
  content: string;
  isError?: boolean;
  /** Structured result kept in the run steps, not sent to the model. */
  data?: Record<string, unknown>;
  /** Ground truth this call produced (tests passed, PR merged…), recorded by the gateway. */
  outcome?: { kind: OutcomeKind; subject?: string; summary?: string; details?: Record<string, unknown> };
  /** Built-in `ask_user` only: suspend the run until a person answers this question. */
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
  /** A mission's tool (agent mode, ADR 0029): its approvals are bound to that mission too. */
  missionId?: string;
  /** Human summary of a call, for approval cards. */
  describe?(input: Record<string, unknown>): { title: string; detail?: string };
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/** Supplies tools for a run. The gateway filters them by the agent's scopes. */
export interface ToolSource {
  readonly name: string;
  tools(ctx: ToolContext): Promise<ToolDefinition[]>;
}
