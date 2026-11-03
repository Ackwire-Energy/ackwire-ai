import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import { redactSecrets } from "@agenteschat/adapters/secret-box";
import { ACCOUNT_MISSING_MESSAGE, accountEnv, opencodeKeyOf, withoutSignIns } from "./accounts";
import {
  CODEX_TOOL_OUTPUT_MAX,
  type CodexBrainEvent,
  CodexThreads,
  codexProfileOf,
  codexThreadKey,
} from "./brain-codex";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { OPENCODE_BIN, resolveCommand } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, redactDeep } from "./mcp";
import { resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The OpenCode branch of `brain.turn` (protocol 39, ADR 0132): one agent turn as one run of OpenCode's CLI
 * (`opencode run --format json`), its lines turned into brain events. Read in the CLI's source at v1.19.5
 * (`packages/opencode/src/cli/cmd/run.ts`) and opencode.ai/docs/cli, …/config, …/mcp-servers, …/permissions
 * (2026-11-02).
 *
 * - `opencode run --format json [--model provider/model] [--session <id>]`, an argv with no prompt in it: the CLI
 *   reads a piped standard input as the message, so the prompt goes there (no argument limit). A new session's
 *   prompt leads with the engine's context (OpenCode has no system prompt flag).
 * - The session: every line carries `sessionID`; our session → OpenCode's lives in
 *   `<runner home>/brain/opencode-sessions.json` (per account, like Codex's threads). A runner that lost it starts a
 *   new session, with the context again.
 * - Everything we set rides on `OPENCODE_CONFIG_CONTENT`: our MCP server under `agenteschat_agentes` (stdio
 *   `agentes-runner mcp --run <run>`, or the bridge's URL), the token, socket and home as `{env:…}` references, the
 *   permissions (ADR 0053 §3), no sharing, no self-update. OpenCode deep-merges it over the other configs it reads,
 *   and joins their plugin lists, so it removes nothing they add: those configs are kept empty instead.
 *   `OPENCODE_DISABLE_PROJECT_CONFIG`: no project `opencode.json` or `.opencode/`. Its global config folder
 *   (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`) is `<runner home>/brain/opencode-config`, emptied of everything but
 *   OpenCode's own packages before each turn, so a `work` turn's writes there never reach a later turn. A
 *   `~/.opencode` with settings, plugins, agents, modes or tools refuses the turn (OpenCode always reads it, and only
 *   a person should remove it). `OPENCODE_PERMISSION`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` aren't inherited.
 *   Left as they are: the computer's managed config folder (its administrator's, root's to write).
 * - The free tier (`freeTier`: no account, a computer nobody connected): no stray key in the env and
 *   `enabled_providers: ["opencode"]`, so no key the runner or the computer holds thinks for anyone's agent.
 * - ADR 0053 §3: `plan` denies edits, commands, sub-agents and folders outside the turn's; `work` allows everything
 *   inside it. OpenCode has no sandbox: its own permission checks are all that hold it, and `run` rejects whatever
 *   would ask (the model goes on without it).
 * - Events: `text` (a whole text part, OpenCode streams no smaller pieces) is a delta; `tool_use` completed or failed
 *   is an executed `tool_call` (transcript only; our bridge's calls left out: the engine ran them); `step_finish`
 *   adds up the tokens; `error` fails the turn. The process's clean exit ends it. Usage is the person's (`source:
 *   "plan"`, cost zero for us): the free tier costs nothing, a key's spend is on OpenCode's console.
 * - No live steering: `run` takes nothing mid-turn, so messages wait for the turn's end (`brain.steer` answers
 *   `unsupported`).
 * - ADR 0041/0059: a turn with an `account` runs with that account's folder as OpenCode's XDG folders
 *   (`accountEnv`) and its sealed key as the `opencode` provider's key. Without one, the computer's own OpenCode:
 *   its own sign-ins, or the free tier with none.
 */

const KILL_GRACE_MS = 5000;

/** `brain.turn` with `kind: "opencode"`. */
export interface OpencodeBrainTurnRequest {
  runId: string;
  kind: "opencode";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  permissions?: { mode?: "plan" | "work" };
  keepAlive?: boolean;
  /** No account on a computer nobody connected: OpenCode's own free tier and nothing else (ADR 0132). */
  freeTier?: boolean;
}

/** Where our session → OpenCode session ids live in the runner home. */
export const opencodeSessionsFile = (runnerHome: string) => path.join(runnerHome, "brain", "opencode-sessions.json");

/** OpenCode's global config folder for our turns: emptied before each one but for `OPENCODE_CONFIG_KEPT`. */
export const opencodeConfigDir = (runnerHome: string) => path.join(runnerHome, "brain", "opencode-config");

/** What OpenCode keeps in its config folder itself (`@opencode-ai/plugin` installed with bun): kept between turns. */
const OPENCODE_CONFIG_KEPT = new Set(["node_modules", "package.json", "bun.lock", ".gitignore"]);

/** What OpenCode reads from `~/.opencode` on every run: settings, plugins, agents, modes, tools. */
export const OPENCODE_HOME_LOADED = [
  "opencode.json",
  "opencode.jsonc",
  "plugin",
  "plugins",
  "agent",
  "agents",
  "mode",
  "modes",
  "tool",
  "tools",
] as const;

/** Empties (or makes) the config folder, keeping only `OPENCODE_CONFIG_KEPT`. */
export function resetOpencodeConfig(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (!OPENCODE_CONFIG_KEPT.has(name)) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** What of `OPENCODE_HOME_LOADED` is in `<home>/.opencode`. */
export const opencodeHomePlanted = (home: string) =>
  OPENCODE_HOME_LOADED.filter((name) => existsSync(path.join(home, ".opencode", name)));

/** OpenCode's answer to a `--session` it no longer has. */
const SESSION_GONE = /session not found/i;

/** The env name the bridge's run id comes through (`{env:…}` in the config). */
export const OPENCODE_RUN_ENV = "AGENTES_MCP_RUN";

/** The env name an account's key reaches the `opencode` provider through. */
export const OPENCODE_KEY_ENV = "OPENCODE_API_KEY";

/** OpenCode's permissions for a profile (ADR 0053 §3): `plan` reads only; nothing reaches outside the turn's folder. */
export function opencodePermissions(profile: CommandProfile): Record<string, string> {
  return profile === "plan"
    ? { "*": "allow", edit: "deny", bash: "deny", task: "deny", external_directory: "deny" }
    : { "*": "allow", external_directory: "deny" };
}

/**
 * The turn's `OPENCODE_CONFIG_CONTENT`: our MCP server alone, the permissions, the account's key. Every value that
 * changes per turn is an `{env:…}` reference.
 */
export function opencodeConfig(input: {
  command?: string[];
  url?: string;
  profile: CommandProfile;
  /** The account has a key: the `opencode` provider reads it from `OPENCODE_API_KEY`. */
  key?: boolean;
  /** OpenCode's own provider alone. */
  freeTier?: boolean;
}): string {
  const env = (name: string) => `{env:${name}}`;
  const [command, ...args] = input.command ?? [];
  const server = input.url
    ? { type: "remote", url: input.url, headers: { Authorization: `Bearer ${env(CODEX_MCP_ENV[0])}` }, enabled: true }
    : {
        type: "local",
        command: [command ?? "agentes-runner", ...args, "mcp", "--run", env(OPENCODE_RUN_ENV)],
        environment: Object.fromEntries(CODEX_MCP_ENV.map((name) => [name, env(name)])),
        enabled: true,
      };
  return JSON.stringify({
    mcp: { [CODEX_MCP_SERVER]: server },
    permission: opencodePermissions(input.profile),
    share: "disabled",
    autoupdate: false,
    ...(input.key ? { provider: { opencode: { options: { apiKey: env(OPENCODE_KEY_ENV) } } } } : {}),
    ...(input.freeTier ? { enabled_providers: ["opencode"] } : {}),
  });
}

/** The `opencode` arguments for one turn (the prompt goes on standard input). */
export function opencodeTurnArgs(input: { session?: string; model?: string }): string[] {
  return [
    "run",
    "--format",
    "json",
    ...(input.model ? ["--model", input.model] : []),
    ...(input.session ? ["--session", input.session] : []),
  ];
}

/** The message: a new session's leads with the engine's context. */
export const opencodePrompt = (system: string, prompt: string, newSession: boolean) =>
  newSession && system.trim() ? `${system.trim()}\n\n${prompt}` : prompt;

const USAGE_LIMIT =
  /usage limit|rate.?limit|too many requests|\b429\b|quota|insufficient (?:balance|credits|funds)|out of (?:credits|usage)|spend(?:ing)? limit|free (?:tier|usage) (?:limit|exceeded)/i;
/** OpenCode can't authenticate (a revoked or wrong key). */
export const OPENCODE_AUTH =
  /unauthori[sz]ed|\b401\b|invalid (?:api )?key|missing api key|authentication (?:failed|required)/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `opencode_failed`. */
export function opencodeProblem(problem: string, worked = false): CodexBrainEvent[] {
  if (USAGE_LIMIT.test(problem))
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, worked }];
  if (OPENCODE_AUTH.test(problem)) return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "opencode_failed", message: problem, retryable: true }];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (text: string) =>
  text.length > CODEX_TOOL_OUTPUT_MAX ? `${text.slice(0, CODEX_TOOL_OUTPUT_MAX)}\n…` : text;

/** An `error` line's words: `error.data.message`, else `error.message`, else its name. */
const errorText = (e: unknown) =>
  isRecord(e)
    ? str(isRecord(e.data) ? e.data.message : undefined) || str(e.message) || str(e.name) || "The turn failed"
    : str(e) || "The turn failed";

/** `opencode run --format json` lines → brain events, plus what the turn's end needs. */
export class OpencodeEventMapper {
  session?: string;
  streamed = "";
  /** The text after the turn's last tool call: its answer (what came before was narration). */
  answer = "";
  failed?: string;
  private worked = false;
  private tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0 };

  constructor(private readonly opts: { model?: string; redact?: (text: string) => string } = {}) {}

  private clean(text: string) {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  line(raw: string): CodexBrainEvent[] {
    const text = raw.trim();
    if (!text.startsWith("{")) return [];
    try {
      const ev = JSON.parse(text) as unknown;
      return isRecord(ev) ? this.event(ev) : [];
    } catch {
      return [];
    }
  }

  event(ev: Record<string, unknown>): CodexBrainEvent[] {
    if (str(ev.sessionID)) this.session = str(ev.sessionID);
    const part = isRecord(ev.part) ? ev.part : {};
    switch (ev.type) {
      case "text": {
        const said = this.clean(str(part.text));
        if (!said.trim()) return [];
        // Each text part is a whole paragraph of its own (before and after tools).
        const delta = this.streamed && !this.streamed.endsWith("\n") ? `\n\n${said}` : said;
        this.streamed += delta;
        this.answer = this.answer ? `${this.answer}\n\n${said}` : said;
        return [{ type: "text_delta", text: delta }];
      }
      case "tool_use": {
        this.answer = "";
        const state = isRecord(part.state) ? part.state : {};
        if (state.status !== "completed" && state.status !== "error") return [];
        this.worked = true;
        const tool = str(part.tool);
        // Our bridge's tools (`<server>_<tool>`): the engine records its own calls.
        if (!tool || tool.startsWith(`${CODEX_MCP_SERVER}_`)) return [];
        const failed = state.status === "error";
        const output = failed ? str(state.error) || "The tool failed." : str(state.output);
        return [
          {
            type: "tool_call",
            id: str(part.callID) || str(part.id) || `opencode-${Math.random().toString(36).slice(2)}`,
            name: tool.slice(0, 128),
            input: redactDeep(isRecord(state.input) ? state.input : {}, (t) => this.clean(t)),
            executed: { content: cut(this.clean(output)), ...(failed ? { isError: true } : {}) },
          },
        ];
      }
      case "step_finish": {
        const t = isRecord(part.tokens) ? part.tokens : {};
        const cache = isRecord(t.cache) ? t.cache : {};
        this.tokens.input += num(t.input);
        this.tokens.output += num(t.output) + num(t.reasoning);
        this.tokens.cacheRead += num(cache.read);
        this.tokens.cacheWrite += num(cache.write);
        this.tokens.steps++;
        return [];
      }
      case "error":
        this.failed = this.clean(errorText(ev.error));
        return [];
      default:
        return [];
    }
  }

  /** The turn's end: its usage (when a step reported tokens), then one `done`, or `error` (after `limit`). */
  finish(input: { exitCode: number | null; sessionId: string; stderr?: string }): CodexBrainEvent[] {
    const { input: read, output, cacheRead, cacheWrite, steps } = this.tokens;
    const usage: CodexBrainEvent[] = steps
      ? [
          {
            type: "usage",
            input: read + cacheRead + cacheWrite,
            output,
            source: "plan",
            ...(this.opts.model ? { model: this.opts.model } : {}),
            ...(cacheRead ? { cacheRead } : {}),
            ...(cacheWrite ? { cacheWrite } : {}),
          },
        ]
      : [];
    const problem =
      this.failed ??
      (input.exitCode === 0
        ? undefined
        : `OpenCode exited with code ${input.exitCode ?? "?"}${input.stderr ? `: ${this.clean(input.stderr)}` : ""}`);
    if (problem) return [...usage, ...opencodeProblem(problem, this.worked)];
    return [...usage, { type: "done", text: this.answer || this.streamed, session: { id: input.sessionId } }];
  }
}

export interface OpencodeTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
  /** The account (its sessions are its own): its folder, and its key. */
  account?: { id: string; home: string; key?: string };
  profile?: CommandProfile;
  freeTier?: boolean;
}

export interface OpencodeTurnOptions {
  sessions: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Tests: the executable. */
  bin?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
}

/** Runs one OpenCode turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runOpencodeTurn(input: OpencodeTurnInput, opts: OpencodeTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  if ((opts.platform ?? process.platform) === "win32") {
    return fail("unsupported", "The OpenCode brain isn't supported on Windows yet.");
  }
  const key = input.account?.key;
  const sessionKey = codexThreadKey(input.sessionId, input.account?.id);
  const inherited: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const home = inherited.HOME || os.homedir();
  const planted = opencodeHomePlanted(home);
  if (planted.length) {
    return fail(
      "opencode_failed",
      `OpenCode on this computer reads ${planted.join(", ")} in ${path.join(home, ".opencode")} on every run, which could change what an agent may do. Move them out of that folder for agents to think with OpenCode.`,
    );
  }
  const configDir = opencodeConfigDir(opts.runnerHome);
  try {
    resetOpencodeConfig(configDir);
  } catch (err) {
    return fail("opencode_failed", err instanceof Error ? err.message : String(err), true);
  }
  for (const name of ["OPENCODE_PERMISSION", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]) {
    delete inherited[name];
  }
  const base: NodeJS.ProcessEnv = {
    ...(input.freeTier && !input.account ? withoutSignIns(inherited) : inherited),
    [OPENCODE_RUN_ENV]: input.runId,
    [CODEX_MCP_ENV[0]]: input.mcp.token,
    ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
    [CODEX_MCP_ENV[2]]: opts.runnerHome,
  };
  const env = input.account ? accountEnv("opencode", input.account.home, base) : base;
  // The agent's commands inherit XDG_CONFIG_HOME: gh keeps finding its sign-in where it was.
  env.GH_CONFIG_DIR ??= path.join(inherited.XDG_CONFIG_HOME || path.join(home, ".config"), "gh");
  env.XDG_CONFIG_HOME = configDir;
  env.OPENCODE_CONFIG_DIR = configDir;
  env.OPENCODE_CONFIG_CONTENT = opencodeConfig({
    ...(input.mcp.url ? { url: input.mcp.url } : { command: opts.mcpCommand }),
    profile: input.profile ?? "work",
    key: Boolean(key),
    freeTier: Boolean(input.freeTier && !input.account),
  });
  if (key) env[OPENCODE_KEY_ENV] = key;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  // Language servers would be downloaded, unpinned, into each agent's home.
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  // The agent's shell could print the key (its env, its file in the lent folder).
  const redact = key
    ? (text: string) => redactSecrets(opts.redact ? opts.redact(text) : text, [{ name: OPENCODE_KEY_ENV, value: key }])
    : opts.redact;

  const once = async (session: string | undefined) => {
    const args = opencodeTurnArgs({ ...(session ? { session } : {}), ...(input.model ? { model: input.model } : {}) });
    const mapper = new OpencodeEventMapper({
      ...(input.model ? { model: input.model } : {}),
      ...(redact ? { redact } : {}),
    });
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? OPENCODE_BIN, env.PATH), args, {
        cwd: input.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      return { mapper, exit: { code: null, error: err instanceof Error ? err : new Error(String(err)) }, stderr: "" };
    }
    // A CLI gone before it read the prompt fails the turn by its exit, not by a broken pipe.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opencodePrompt(input.system, input.prompt, !session));
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    const lines = createInterface({ input: child.stdout as NonNullable<ChildProcess["stdout"]> });
    (lines as unknown as EventEmitter).on("line", (line: string) => {
      for (const event of mapper.line(line)) opts.emit(event);
      if (mapper.session) opts.sessions.set(sessionKey, mapper.session);
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      const proc = child as unknown as EventEmitter;
      proc.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          resolve({ code: null, error });
        }
      });
      proc.on("close", (code: number | null) => {
        if (!settled) {
          settled = true;
          resolve({ code });
        }
      });
    });
    opts.signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    lines.close();
    return { mapper, exit, stderr: stderr.trim() };
  };

  const stored = opts.sessions.get(sessionKey);
  let turn = await once(stored);
  // OpenCode lost the session (its storage is in the agent's or the account's folder, our map in the runner home):
  // forget it and start a new one, with the context again.
  if (
    stored &&
    !opts.signal.aborted &&
    turn.exit.code !== 0 &&
    !turn.mapper.streamed &&
    SESSION_GONE.test(`${turn.mapper.failed ?? ""}\n${turn.stderr}`)
  ) {
    opts.sessions.delete(sessionKey);
    turn = await once(undefined);
  }
  if (opts.signal.aborted) return fail("canceled", "The turn was canceled.");
  const { mapper, exit, stderr } = turn;
  if (exit.error) {
    const missing = (exit.error as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "opencode_missing" : "opencode_failed",
      missing ? "OpenCode's CLI is not installed on this computer." : exit.error.message,
      true,
    );
  }
  for (const event of mapper.finish({ exitCode: exit.code, sessionId: input.sessionId, stderr })) {
    opts.emit(event);
  }
}

/** What the runner's `brain.turn` handler hands the OpenCode branch. */
export interface OpencodeBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  sessions?: CodexThreads;
  bin?: string;
  grants?: string[];
  accounts?: { accountDir(kind: "opencode", id: string): string | null };
  spawn?: Spawn;
}

const sessionStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "opencode"`: the turn's folder in the agent's own folder, its secrets, then the turn. */
export async function handleOpencodeBrainTurn(
  ctx: OpencodeBrainContext,
  req: OpencodeBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "OpenCode is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  if (typeof req.model === "string" && req.model && !/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(req.model)) {
    throw new RunnerError("bad_request", "model is provider/model");
  }
  const freeTier = req.freeTier === true && !req.account;
  if (freeTier && typeof req.model === "string" && req.model && !req.model.startsWith("opencode/")) {
    throw new RunnerError("bad_request", "OpenCode's free tier thinks only with OpenCode's own models");
  }
  let cwd = ctx.folder;
  if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead).
  let account: OpencodeTurnInput["account"];
  const accountId: unknown = req.account;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
    const home = ctx.accounts?.accountDir("opencode", accountId);
    if (!home) {
      scope.emit({
        type: "error",
        code: "account_missing",
        message: ACCOUNT_MISSING_MESSAGE.opencode,
        retryable: false,
      });
      return;
    }
    const key = await opencodeKeyOf(home);
    account = { id: accountId, home, ...(key ? { key } : {}) };
  }
  const secrets = await agentSecrets(ctx.secretsDir, req.agent);
  const file = opencodeSessionsFile(ctx.runnerHome);
  const sessions = ctx.sessions ?? sessionStores.get(file) ?? new CodexThreads(file);
  sessionStores.set(file, sessions);
  await runOpencodeTurn(
    {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
      ...(account ? { account } : {}),
      profile: codexProfileOf(req),
      ...(freeTier ? { freeTier } : {}),
    },
    {
      sessions,
      emit: scope.emit,
      signal: scope.signal,
      runnerHome: ctx.runnerHome,
      ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
      ...(secrets ? { env: secrets.env, redact: secrets.redact } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
    },
  );
}
