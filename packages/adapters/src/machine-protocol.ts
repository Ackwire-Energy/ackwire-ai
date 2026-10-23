/**
 * The wire protocol between our server and the runner on a connected
 * computer (ADR 0025). JSON text frames over one WebSocket the runner opens
 * to `/api/machines/connect`. Shared by the server and the runner bundle, so
 * this file imports nothing.
 */

/** Bumped on breaking changes; the server refuses runners older than `MIN_RUNNER_PROTOCOL`. */
export const MACHINE_PROTOCOL_VERSION = 15;
export const MIN_RUNNER_PROTOCOL = 1;
/** From this protocol on, requests carry `agent` and each agent works in its own folder. */
export const AGENT_FOLDERS_PROTOCOL = 2;
/** From this protocol on, the runner keeps secrets for each agent (`op: "secret"`, ADR 0027). */
export const SECRETS_PROTOCOL = 3;
/** From this protocol on, the runner runs background tasks that outlive a request (`task.*`, ADR 0029). */
export const TASKS_PROTOCOL = 4;
/**
 * From this protocol on, a task can belong to a mission: the runner gives the
 * executor the local `agentes` MCP server and relays its calls (`mcp.call` /
 * `mcp.result`, ADR 0029).
 */
export const MISSION_PROTOCOL = 5;
/**
 * From this protocol on, the runner answers `task.output` (the last human
 * lines of a task's log, ADR 0029) and reports pull requests it sees in a
 * task's output (`task.event` `prUrl`). Older runners ignore unknown ops, so
 * the server only asks runners at this protocol or later.
 */
export const TASK_OUTPUT_PROTOCOL = 6;
/**
 * From this protocol on, `hello` says which coding CLIs the machine has
 * (`executors`), and a mission task carries its permission profile
 * (`mission.mode`, `mission.branchPrefix`): Claude Code gets a generated
 * `--settings` file with what it may run without asking (ADR 0029).
 */
export const EXECUTORS_PROTOCOL = 7;
/**
 * From this protocol on, the `agentes` MCP server is a bridge (ADR 0032): a
 * mission task (or a computer-brain run) carries a server-issued token
 * (`mission.mcpToken`), the runner sends it with every `mcp.call`, and
 * `tools/list` is asked from the server (`mcp.list` / `mcp.tools`): the
 * tools are the run's Tool Gateway tools, not a fixed list.
 */
export const BRIDGE_PROTOCOL = 8;
/** Server-issued run tool tokens (ADR 0032): `agr_` + 32 random bytes in base64url. */
export const RUN_TOOL_TOKEN_PREFIX = "agr_";
export const isRunToolToken = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 100 && /^agr_[A-Za-z0-9_-]{20,96}$/.test(v);
/**
 * From this protocol on, the runner runs conversational brain turns
 * (`brain.turn`, ADR 0032): Claude Code thinks for an agent on the machine,
 * streaming `brain.event` frames, and keeps one process per thread alive.
 * `hello.executors.claude` also says whether Claude Code is logged in. The
 * server never sends `brain.turn` to an older runner.
 */
export const BRAIN_PROTOCOL = 8;
/**
 * From this protocol on (ADR 0036): requests carry the agent's display name
 * (`agent.name`, for the runner's local activity log), and the owner can
 * pause the computer. `hello.paused` and `runner.state` say whether it is
 * paused and until when; the server sends no new work to a paused machine
 * (it refuses with `machine_paused`), and the runner refuses new work with
 * `paused` too, as a guard. Work already running finishes.
 */
export const PAUSE_PROTOCOL = 9;
/**
 * From this protocol on (ADR 0036, v0.2): access lives on the machine. The
 * runner reports which folders outside the agents' own folders are allowed,
 * for which agents, and which tools are on (`hello.access`, `access.changed`).
 * Request paths may be absolute when they fall inside a folder allowed for
 * that agent. An agent asks for a folder with `access.request`; the person
 * decides on the machine and the runner sends `access.decided`. The server
 * can never widen access; it only shows it and asks the runner to reduce it
 * (`access.reduce`).
 */
export const ACCESS_PROTOCOL = 10;

/**
 * From this protocol on (ADR 0024 addendum): `git.sync` clones or updates an
 * agent's checkouts of GitHub repositories inside its own folder
 * (`repos/<owner>/<name>`), through our git proxy. The request carries our
 * short-lived proxy credential (never a GitHub token); the runner keeps it
 * outside the agent's folder and points each checkout's remote and
 * credential helper at it. The server never sends `git.sync` to an older runner.
 */
export const GIT_PROTOCOL = 11;

/**
 * From this protocol on (ADR 0040): the agent browser. The runner drives
 * `agent-browser` (pinned below), one headless session per agent with its
 * profile in the agent's folder, when the person turned `access.tools.browser`
 * on. `hello.browser` says whether it can serve. `browser.act` runs one
 * `agent-browser` command; `browser.stream.*` relays its JPEG stream as
 * `browser.frame` frames only while someone watches, and `browser.input` sends
 * a person's input back. The server never sends `browser.*` to an older runner.
 */
export const BROWSER_PROTOCOL = 12;

/**
 * From this protocol on (ADR 0041): accounts and effort for the computer
 * brains. An account is a folder in `<runner home>/accounts/<kind>/<id>`,
 * used as `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex); the CLI
 * keeps its own sign-in there and the runner never reads it. `op: "account"`
 * starts a sign-in (`begin`), takes the Claude code sealed to the machine
 * (`code`), reports it (`status`), cancels it, lists and removes accounts.
 * `hello.accounts` lists them; `brain.turn` carries `account` and `effort`.
 * The server never sends these to an older runner.
 */
export const ACCOUNTS_PROTOCOL = 13;
/**
 * From this protocol on (ADR 0044): a mission has one worktree and one
 * branch (`mission.worktree`: `ensure` creates or checks it and copies the
 * files git ignores, `remove` takes the folder away). A task can end in a
 * commit (`TaskStart.commit`, `TaskDone.startSha` / `endSha`) and can check
 * how far the mission's base moved (`TaskStart.baseCheck`). The server never
 * starts a mission on an older runner.
 */
export const MISSION_WORKTREE_PROTOCOL = 14;
/**
 * From this protocol on (live steering): `brain.steer` hands messages to a
 * Claude Code turn in progress (stream-json user lines on its stdin, read at
 * its next tool boundary), and the turn reports which it read
 * (`brain.event` `steer_read`). Older runners would drop the unknown op: the
 * server never sends it to them (their turns read new messages at the end).
 */
export const STEER_PROTOCOL = 15;

/** Which CLI an account signs in. */
export type AccountKind = "claude_code" | "codex";
export const ACCOUNT_KINDS: readonly AccountKind[] = ["claude_code", "codex"];
export const isAccountKind = (v: unknown): v is AccountKind => v === "claude_code" || v === "codex";
/** Account and sign-in ids: UUIDs (the server makes them; the desktop app's runner too). */
export const isAccountId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

/** How hard a computer brain thinks (Claude Code `--effort`; Codex maps `xhigh`/`max` to `high`). */
export type BrainEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const BRAIN_EFFORTS: readonly BrainEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const isBrainEffort = (v: unknown): v is BrainEffort =>
  typeof v === "string" && (BRAIN_EFFORTS as readonly string[]).includes(v);

/** An account on the machine, as the runner sees it (`hello.accounts`, `account` replies). No secrets. */
export interface RunnerAccountInfo {
  id: string;
  kind: AccountKind;
  /** The CLI's status command says it is signed in. */
  loggedIn: boolean;
  email?: string;
  /** `pro`, `max`, `team`, `plus`… as the CLI says. */
  plan?: string;
}

/** Where a sign-in is: waiting for the person, done (signed in), failed or expired (folder removed). */
export type AccountLoginState = "waiting" | "done" | "failed" | "expired";

/**
 * `op: "account"` (protocol 13, ADR 0041 §2). `begin` starts the CLI's sign-in
 * in a new folder named `loginId` (it becomes the account id). Claude Code
 * answers the URL it printed and an ephemeral public key; the browser seals the
 * code the person pastes with it (AAD `accountCodeAad`), and `code` hands it to
 * the waiting CLI. Codex answers its device URL and one-time code. A sign-in
 * expires after `ACCOUNT_LOGIN_TTL_MS`.
 */
export type AccountRequest =
  /** `again`: sign in once more to the existing account `loginId` (it was signed out); its folder stays on failure. */
  | { action: "begin"; kind: AccountKind; loginId: string; again?: boolean }
  | { action: "code"; loginId: string; aad: string; box: WireSecretBox }
  | { action: "status"; loginId: string }
  | { action: "cancel"; loginId: string }
  | { action: "list" }
  | { action: "remove"; kind: AccountKind; accountId: string };

export const ACCOUNT_LOGIN_TTL_MS = 15 * 60_000;
/** Accounts per machine: the runner adds no more, and a list this long is never taken as complete by the server. */
export const MAX_MACHINE_ACCOUNTS = 100;
/** The AAD that binds a sealed Claude sign-in code to its sign-in and organization. */
export const accountCodeAad = (loginId: string, orgId: string) => `${loginId}|${orgId}|account`;

/** The `agent-browser` release the runner and the desktop app ship (ADR 0040 §2). */
export const AGENT_BROWSER_VERSION = "0.39.1";
/** Targets of `agent-browser`'s release assets (`agent-browser-<target>`, `.exe` on Windows). */
export type AgentBrowserTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-x64";
/** SHA-256 (hex) of each release asset of `AGENT_BROWSER_VERSION`, checked before the binary is used. */
export const AGENT_BROWSER_SHA256: Record<AgentBrowserTarget, string> = {
  "darwin-arm64": "cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef",
  "darwin-x64": "339cb9aa6dfd404856cf938df34cd3b4779c61dfd57fc257be11b14fd1a885f9",
  "linux-arm64": "9d8fdc586056df65747927ae166157c83af91b52cea287175e5544afd2591d33",
  "linux-x64": "6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc",
  "win32-x64": "af1ff5f2afd5c187fb50ac3bbc1e7114baadc180d67cef63f644af9031be5049",
};
/** `darwin-arm64` → `agent-browser-darwin-arm64`; `win32-x64` → `agent-browser-win32-x64.exe`. */
export const agentBrowserAsset = (target: AgentBrowserTarget) =>
  `agent-browser-${target}${target.startsWith("win32") ? ".exe" : ""}`;

/** Largest pieces of browser frames. */
export const BROWSER_LIMITS = {
  /** One `browser.frame` image (base64 JPEG). */
  frameBytes: 3 * 1024 * 1024,
  /** Events in one `browser.input`. */
  inputEvents: 100,
  /** A `text` input event (pasted or typed through the app's field). */
  inputText: 10_000,
  /** A `browser.act` command name, and its arguments as JSON characters. */
  command: 64,
  args: 64 * 1024,
  url: 2048,
  message: 500,
} as const;

/** `hello.browser` (protocol 12): whether this machine can run the agent browser. */
export interface RunnerBrowserInfo {
  /** The binary is there (checked) and a Chrome was found. */
  available: boolean;
  /** `agent-browser`'s version. */
  version?: string;
  /** The Chrome it uses ("Google Chrome 141.0…", "Chrome for Testing …"). */
  chrome?: string;
  /** Why it isn't available, for people ("Chrome's libraries are missing: run …"). */
  reason?: string;
}

/**
 * A person's turn in an agent's browser (`browser.handoff`, ADR 0040 §6), as
 * the desktop app shows it: a request waiting for someone (`pending`) or a
 * person in control (`active`). The runner only shows it; nothing here grants
 * anything.
 */
export interface BrowserHandoffInfo {
  status: "pending" | "active";
  /** The person in control (their display name), when `active`. */
  controller?: string;
  /** What the agent asked for, short. */
  request?: string;
  /** Where the request's card is (`/org/…/c/…?m=…`), to open it. */
  link?: string;
}

/** `watch`: about 1 frame a second for viewers; `control`: 10–15 while a person drives. */
export type BrowserStreamMode = "watch" | "control";

/** Bits of CDP's modifier mask: Alt 1, Control 2, Meta 4, Shift 8. */
export type BrowserModifiers = number;

/** A person's input during a take over, in page coordinates (CSS pixels of the frame's viewport). */
export type BrowserInputEvent =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle" | "none";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: BrowserModifiers;
    }
  | {
      kind: "key";
      type: "keyDown" | "keyUp" | "char";
      key: string;
      code?: string;
      text?: string;
      modifiers?: BrowserModifiers;
    }
  | {
      kind: "touch";
      type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
      touchPoints: { x: number; y: number }[];
      modifiers?: BrowserModifiers;
    }
  /** Whole text into the focused field (CDP `Input.insertText`): accents, paste, the app's own text field. */
  | { kind: "text"; text: string };

/** What a frame shows. */
export interface BrowserFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor?: number;
  /** The active tab's URL when the frame was taken. */
  url?: string;
}

/** Where an agent's checkouts live inside its folder. */
export const GIT_CHECKOUTS_DIR = "repos";
/** `owner/name` → `repos/owner/name` (relative to the agent's folder). */
export const gitCheckoutDir = (repo: string) => `${GIT_CHECKOUTS_DIR}/${repo}`;
/** `owner/name` as GitHub allows it (no `.` or `..` names). */
export const isGitRepoName = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v) &&
  v.split("/").every((part) => part !== "." && part !== "..");

/** Largest pieces of a `git.sync`. */
export const GIT_SYNC_LIMITS = {
  repos: 50,
  /** A clone may take this long (big repositories on a slow link). */
  maxSeconds: 3600,
  message: 1000,
} as const;

/**
 * `mission.worktree` (protocol 14, ADR 0044). Paths are relative to the
 * agent's folder.
 *
 * `ensure`: makes sure `path` is a worktree of the repository at `repo` on
 * `branch`. When the folder is missing and the branch exists, it is added
 * again from the branch (after `git worktree prune`); when both are missing
 * and `baseSha` is absent, the branch is created from `repo`'s checked-out
 * branch (when `baseSha` is given and the branch is gone, the answer is
 * `branch_missing`: the work is lost and the server must say so). A new
 * folder gets the files git ignores copied from `repo` (`agentes.json`
 * `copy`, default: untracked `.env*` at the root) and its `.agentes/` stays
 * out of git. Loose changes in an existing folder are left as they are.
 *
 * `remove`: `git worktree remove --force` on `path`, then `git branch -D`
 * when `deleteBranch` is set. A folder that is already gone is not an error.
 *
 * Errors: `not_git` when `repo` is in no git repository (the mission then
 * works in `repo` itself, with no branch); `outside_workspace` when `repo`
 * only sits inside a repository whose top level is outside the agent's
 * folder (never treated as "no git": the server fails the mission's folder).
 *
 * The files `ensure` copies are listed in the worktree's own git dir
 * (`<git-dir>/agentes-copied`, one path per line, never the shared
 * `info/exclude`), and a task's end-of-item commit leaves them out.
 */
export type MissionWorktreeRequest =
  | { action: "ensure"; repo: string; path: string; branch: string; baseSha?: string }
  | { action: "remove"; repo: string; path: string; branch: string; deleteBranch?: boolean };

/** `mission.worktree` `ensure` answer. */
export interface MissionWorktreeEnsured {
  path: string;
  branch: string;
  /** The branch the mission started from (`repo`'s checked-out branch when it was created). */
  baseBranch: string;
  baseSha: string;
  /** The folder was (re)made now: the server runs `setupCommand` before any item. */
  created: boolean;
  /** Whether the folder has loose changes (after a crash mid-item). */
  dirty: boolean;
  /**
   * What prepares the folder: `agentes.json` `setup`, else the install for
   * the root lockfile (`bun install`, `pnpm install --frozen-lockfile`,
   * `npm ci`, `yarn install --frozen-lockfile`); null when there is nothing
   * to run. Only meaningful when `created`.
   */
  setupCommand: string | null;
  /** Files copied from `repo`, relative to the folder. */
  copied: string[];
}

/** `git.sync` (protocol 11): clone or update an agent's checkouts through our proxy. */
export interface GitSyncRequest {
  /** Our proxy for the org's GitHub connection (`…/api/git/{orgId}/{connectionId}/`) and this agent's credential there. */
  proxy: { base: string; token: string };
  /** The commit author set in each checkout ("Theo (agentes)", "theo@agents.agentes.chat"). */
  author: { name: string; email: string };
  /** `clone: false`: update it only when it is already there. `dir` is relative to the agent's folder. */
  repos: { repo: string; dir: string; clone: boolean }[];
  /** Also update every checkout already under `repos/` (one `owner/name` level). */
  existing?: boolean;
  /** For the whole request; each fetch stops at the deadline (a slow or offline network never blocks). */
  timeoutSeconds: number;
  /** Send git's progress as `output` frames. */
  stream?: boolean;
}

export interface GitSyncRepo {
  repo: string;
  /** Relative to the agent's folder. */
  dir: string;
  /** Absolute path on the machine. */
  path?: string;
  /** `missing`: not cloned (and not asked to); `failed`: see `message` (offline, refused by the proxy…). */
  status: "cloned" | "updated" | "missing" | "failed";
  /** The branch checked out now, and the remote's default branch. */
  branch?: string;
  defaultBranch?: string;
  /** Short commit id of HEAD. */
  head?: string;
  /** Why it failed, or a warning (local changes kept the default branch from moving). */
  message?: string;
}

/** No valid `hello` within this time closes the socket. */
export const HELLO_TIMEOUT_MS = 10_000;
/** The server pings this often; the runner reconnects after two missed pings. */
export const HEARTBEAT_MS = 25_000;
/** Largest text frame either side accepts (a `write` of 5 MB is about 6.7 MB in base64). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** `read`/`write` bodies (base64 in JSON); larger files go through `push`. */
export const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

export const MACHINE_TOKEN_PREFIX = "agm_";

/** Same as `SecretBox` and `SecretTarget` in `secret-box.ts` (this file imports nothing). */
export interface WireSecretBox {
  v: number;
  epk: string;
  iv: string;
  ct: string;
}
export type WireSecretTarget = { kind: "env" } | { kind: "file"; path: string };

/**
 * Secrets of the request's agent (ADR 0027): `keypair` makes the key for a
 * request (the private key stays on the machine), `deliver` opens the box and
 * stores the value, `discard` drops a request's key, `remove` forgets a secret.
 */
export type SecretRequest =
  | { action: "keypair"; requestId: string }
  | { action: "deliver"; requestId: string; name: string; target: WireSecretTarget; aad: string; box: WireSecretBox }
  | { action: "discard"; requestId: string }
  | { action: "remove"; name: string };

export type MachineOs = "linux" | "darwin" | "windows" | "other";

/** What runs a background task: Claude Code, Codex, or a plain shell command. */
export type TaskExecutor = "claude" | "codex" | "shell";
export const TASK_EXECUTORS: readonly TaskExecutor[] = ["claude", "codex", "shell"];

/**
 * A background task (protocol 4): started detached on the machine, so it
 * survives the runner restarting and the socket dropping; its output goes to
 * files in `<runner home>/tasks/<taskId>/` and its state to the runner's
 * journal. The runner streams `task.event` frames and sends `task.done` once,
 * until the server acknowledges it (`task.ack`).
 */
export interface TaskStart {
  /** Chosen by the server (a UUID). */
  taskId: string;
  executor: TaskExecutor;
  /** `shell`: the command line. */
  command?: string;
  /** `claude` / `codex`: what to do. */
  prompt?: string;
  /** `claude`: the session to continue (one per conversation); the runner resumes it when it exists. */
  session?: string;
  /** `claude`: the server knows this session ran before (a hint; the runner checks on disk). */
  resume?: boolean;
  /** Relative to the agent's folder (default: the folder itself). */
  cwd?: string;
  /**
   * Work in a new git worktree on this new branch (`<agent folder>/.worktrees/<taskId>`) when `cwd` is a git
   * repository. When it isn't, a `claude`/`codex` task runs without a branch in its own subfolder
   * `<cwd>/work/<last part of the branch>/` (`shell` tasks are refused).
   */
  branch?: string;
  /** Killed (the whole process group) after this long; default and cap are the runner's. */
  maxSeconds?: number;
  /**
   * Protocol 5: the task works for a mission (an item session: it works on
   * the mission's branches; merges, pushes to other branches and deploys are
   * denied). The runner gives the executor the local `agentes` MCP server
   * (bound to this task) and the mission's rules.
   */
  mission?: {
    id: string;
    rules?: string;
    /** Protocol 7: the mission's branches start with this (`agentes/<id>/`); only these may be pushed. */
    branchPrefix?: string;
    /**
     * Commands a person allowed for the whole mission ("Aprovar sempre nesta
     * missão"), as Claude Code permission rules (`Bash(swift *)`); added to
     * a work turn's allow list (the deny list still wins).
     */
    allow?: string[];
    /**
     * Protocol 8: the server's token for this task's tools (ADR 0032). The
     * runner sends it with each `mcp.call` and `mcp.list`; the server checks
     * it is this machine's, for this task, and still live.
     */
    mcpToken?: string;
    /** Protocol 14: `plan` for a read item (ADR 0044): no edits (Claude Code's plan rules, Codex's read-only sandbox). Default `work`. */
    mode?: "plan" | "work";
  };
  /**
   * Protocol 14 (ADR 0044), for a task in a git folder: record `HEAD` when it
   * starts and, when it ends (any way: done, failed, canceled), `git add -A`
   * and commit what changed with this message (nothing when the tree is
   * clean; the runner adds " (stopped)" when the task didn't exit 0: failed,
   * canceled, timed out, interrupted). `TaskDone` then carries `startSha` and
   * `endSha`; a commit a hook refused leaves the changes and says why at the
   * end of `result`.
   */
  commit?: { message: string };
  /** Protocol 14: answer how many commits `branch` has beyond `sha` (`task.start` `baseBehind`). */
  baseCheck?: { branch: string; sha: string };
}

/** A coding CLI on the machine, as `hello` reports it (protocol 7). */
export interface RunnerExecutorInfo {
  /** The first line of `<cli> --version`. */
  version: string;
  /** Protocol 8, `claude` only: `claude auth status` says it is logged in (absent: unknown). */
  loggedIn?: boolean;
  /** Protocol 8, `claude` only: how it is logged in (`claude.ai`, `api_key`…) and the plan (`pro`, `max`, `team`…). */
  authMethod?: string;
  plan?: string;
}

/**
 * One event of a brain turn on the wire (`brain.event`), the same shape as
 * the engine's `BrainEvent` (packages/engine/src/brains/types.ts; this file
 * imports nothing).
 */
export type WireBrainEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      executed?: { content: string; isError?: boolean };
    }
  | {
      type: "usage";
      /** Every input token the turn read (cache included); `cacheRead`/`cacheWrite` say how much of it was cache. */
      input: number;
      output: number;
      source: "api" | "plan";
      model?: string;
      cacheRead?: number;
      cacheWrite?: number;
    }
  | { type: "limit"; resetsAt?: string }
  | { type: "done"; text: string; session?: { id: string } }
  | { type: "error"; code: string; message: string; retryable?: boolean }
  /** Protocol 15: messages handed with `brain.steer` that the turn read (their `uuid`s). */
  | { type: "steer_read"; uuids: string[] };

/**
 * `brain.steer` (protocol 15): messages for the turn of `runId` in progress.
 * Each has its own `uuid` (a UUID the engine maps to its message); `urgent`
 * ("Parar e mandar") asks the CLI to read it now, moving the running tool to
 * the background. Support is what Claude Code's `system/init` says it can do
 * (`msg_lifecycle_v1` for any message, `interrupt_send_now_v1` for urgent
 * ones); a turn that can't take an urgent one answers `unsupported` (the
 * engine stops and restarts the turn instead).
 */
export interface BrainSteerRequest {
  runId: string;
  /** The turn's session (as in its `brain.turn`): with the request's agent, it names the process. */
  session: string;
  messages: Array<{ uuid: string; text: string; urgent?: boolean }>;
}

/**
 * `accepted`: written to the turn (their `uuid`s; read later, `steer_read`).
 * `unsupported`: this turn can't take messages mid-turn (an older CLI, a
 * one-shot process, Codex), or not urgent ones. `no_turn`: no turn of that
 * run runs now.
 */
export type BrainSteerReply =
  | { status: "accepted"; accepted: string[] }
  | { status: "unsupported" | "no_turn"; reason?: string };

/** Most messages and characters per message in one `brain.steer`. */
export const STEER_LIMITS = { messages: 20, text: 100_000 } as const;

/**
 * `brain.turn` (protocol 8, ADR 0032): one conversational turn of an agent
 * whose brain is Claude Code on this machine. The runner streams
 * `brain.event` frames (by `runId`), then `brain.done`, then the request's
 * `result` with the final event (a `done` or an `error`).
 */
export interface BrainTurnRequest {
  runId: string;
  kind: "claude_code" | "codex";
  /** The executor's session (a UUID, stable per thread); `resume`: the server knows it ran before (a hint). */
  session: { id: string; resume: boolean };
  /** Relative to the agent's folder ("" = the folder). */
  cwd: string;
  /** `opus`, `sonnet`, a full model id; absent: the CLI's default. */
  model?: string;
  /** The engine-built context, appended to Claude Code's system prompt when a session starts. */
  system: string;
  /** What this turn says (the new user message). */
  prompt: string;
  /** The MCP bridge for this run: `token` identifies the run to the server (per run). */
  mcp: { token: string; url?: string };
  /** Keep one process per (agent, session) alive between turns (default true). */
  keepAlive?: boolean;
  /** Also load the machine owner's own MCP servers (default false: `--strict-mcp-config`). */
  personalMcp?: boolean;
  /** Command policy (as missions): `work` (default) edits and asks a person for the rest; `plan` reads only. */
  permissions?: { mode?: "plan" | "work"; branchPrefix?: string; allow?: string[] };
  /** Protocol 13: the account folder to run in (`accounts/<kind>/<id>`); absent: the machine's own sign-in. */
  account?: string;
  /** Protocol 13: how hard it thinks; absent: the CLI's default. */
  effort?: BrainEffort;
}

/** Largest strings of a `brain.event` (tool inputs and results are cut, text deltas are small). */
export const BRAIN_LIMITS = {
  delta: 16_000,
  toolText: 4000,
  toolName: 128,
  doneText: 100_000,
  message: 2000,
} as const;

/** A task as the runner's journal has it (in `hello` and `task.status`). */
export interface RunnerTask {
  taskId: string;
  agentId: string;
  /** `interrupted`: the process is gone without an exit (the machine slept, rebooted or killed it). */
  status: "running" | "done" | "interrupted";
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  seconds?: number;
  lastLine?: string;
  files?: string[];
}

/** `task.done`: how a task ended. Sent once per task, again after a reconnect until acknowledged. */
export interface TaskDone {
  taskId: string;
  /** Null when there is no exit code (killed by a signal, or interrupted). */
  exitCode: number | null;
  signal?: string | null;
  seconds: number;
  /** The executor's final answer (Claude Code's `result`), or the last lines of output; capped. */
  result?: string;
  lastLine?: string;
  files?: string[];
  /** Ended by `task.cancel`. */
  canceled?: boolean;
  /** Killed after `maxSeconds`. */
  timedOut?: boolean;
  /** The process vanished without an exit (the machine went down): it may be resumed. */
  interrupted?: boolean;
  /** Claude Code's session id, when it reported one. */
  session?: string;
  /**
   * Commands the executor wasn't allowed to run and nobody approved
   * (Claude Code's `permission_denials`, Codex's declined commands): the
   * task's end notice lists them ("Liberar e repetir").
   */
  denials?: TaskDenial[];
  /** Protocol 14, with `TaskStart.commit`: `HEAD` when the task started and after its commit (equal: nothing changed). */
  startSha?: string;
  endSha?: string;
}

/** One command an executor was refused. */
export interface TaskDenial {
  /** Claude Code's tool name (`Bash`, `WebFetch`…); `Bash` for Codex commands. */
  tool: string;
  /** The command line, or what the tool would touch (a URL, a path). */
  command: string;
}

/** Largest pieces of task frames (characters / entries); the runner cuts, the server cuts again. */
export const TASK_LIMITS = {
  /** Refused commands kept per task, and each one's length. */
  denials: 10,
  denial: 300,
  line: 500,
  files: 50,
  filePath: 300,
  result: 8000,
  tasks: 200,
  /** `task.output`: at most this many lines. */
  outputLines: 200,
  prUrl: 500,
} as const;

/** An agent that uses this machine, as the `agents` frame lists it (protocol 9). */
export interface MachineAgent {
  id: string;
  handle: string;
  name: string;
  look?: { color?: string; eyes?: string; accessory?: string };
}

/** The pause state (protocol 9). `until` null: paused until the owner resumes. */
export interface RunnerPause {
  paused: boolean;
  /** ISO time; absent or null with `paused: true` means "until resumed". */
  until?: string | null;
}

/** The tools a person turns on or off on the machine (protocol 10). */
export interface RunnerTools {
  claude: boolean;
  codex: boolean;
  /** Shell commands (`exec`, `shell` tasks). The same as `exec` in `hello` once protocol 10 is in use. */
  commands: boolean;
  /** Protocol 12: the agent browser (ADR 0040). Absent = off (older runners). */
  browser?: boolean;
}

/** A folder allowed on the machine beyond the agents' own folders, and which agents use it (protocol 10). */
export interface RunnerFolderGrant {
  /** Absolute, normalized path on the machine. */
  path: string;
  /** Agent ids that may use it; empty = allowed on the machine but no agent uses it yet. */
  agents: string[];
}

/** What the machine allows (protocol 10). */
export interface RunnerAccess {
  folders: RunnerFolderGrant[];
  tools: RunnerTools;
}

/** Largest pieces of access frames. */
export const ACCESS_LIMITS = {
  folders: 100,
  path: 1024,
  agentsPerFolder: 100,
  reason: 500,
  /** An `access.request` the person hasn't answered expires after this long. */
  requestTtlMs: 24 * 60 * 60 * 1000,
} as const;

export interface RunnerInfo {
  /** Protocol 4: the tasks in the runner's journal (running, and finished ones not yet acknowledged). */
  tasks?: RunnerTask[];
  /** The runner's own version (`0.1.0`). */
  version: string;
  protocol: number;
  os: MachineOs;
  arch: string;
  hostname: string;
  /** Absolute path of the workspace on the machine (shown to admins only). */
  workspace: string;
  /** `false` when started with `--no-exec`: files and uploads only. */
  exec: boolean;
  /** Protocol 7: the coding CLIs found on the machine's PATH (best effort, cached by the runner). */
  executors?: { claude?: RunnerExecutorInfo; codex?: RunnerExecutorInfo };
  /** Protocol 9: whether the owner paused this computer. */
  paused?: RunnerPause;
  /** Protocol 10: folders and tools allowed on the machine. */
  access?: RunnerAccess;
  /** Protocol 12: whether the agent browser can run here. */
  browser?: RunnerBrowserInfo;
  /** Protocol 13: the accounts on the machine (ADR 0041). */
  accounts?: RunnerAccountInfo[];
}

export interface FileEntry {
  /** Relative to the workspace. */
  path: string;
  isDir: boolean;
  size: number;
}

/**
 * The agent a request is for (protocol 2+). The runner gives each agent its
 * own folder inside the workspace, `<handle>-<first 8 of id>`, and treats it
 * as that request's workspace; a renamed agent keeps its folder (found by id).
 */
export interface AgentScope {
  id: string;
  handle: string;
  /** Protocol 9: the agent's display name, for the machine's activity log. */
  name?: string;
}

/** What the server asks. Paths are always relative to the workspace (the agent's folder when `agent` is set). */
export type MachineRequest = (
  | {
      op: "exec";
      command: string;
      /** Relative to the workspace (default: the workspace). */
      cwd?: string;
      timeoutSeconds: number;
      /** Send `output` frames while it runs. */
      stream: boolean;
    }
  | { op: "read"; path: string; maxBytes: number }
  | { op: "write"; path: string; base64: string }
  | { op: "list"; path: string; depth: number }
  | ({ op: "secret" } & SecretRequest)
  /** Protocol 13: sign-ins and accounts of the computer brains (ADR 0041). Not per agent. */
  | ({ op: "account" } & AccountRequest)
  | ({ op: "task.start" } & TaskStart)
  /** One task, or all of this agent's when `taskId` is omitted. */
  | { op: "task.status"; taskId?: string }
  | { op: "task.cancel"; taskId: string }
  /** Protocol 6: the last `tail` human lines of a task's output (redacted), as the watcher derives them. */
  | { op: "task.output"; taskId: string; tail: number }
  /** Protocol 8: one brain turn (ADR 0032); streams `brain.event` frames while it runs. */
  | ({ op: "brain.turn" } & BrainTurnRequest)
  /** Protocol 15: messages for a brain turn in progress (live steering). */
  | ({ op: "brain.steer" } & BrainSteerRequest)
  /** Protocol 11: clone or update the agent's checkouts through our git proxy. */
  | ({ op: "git.sync" } & GitSyncRequest)
  /** Protocol 14: the mission's worktree (ADR 0044). */
  | ({ op: "mission.worktree" } & MissionWorktreeRequest)
  /**
   * Protocol 10: the request's agent asks for a folder outside its own. The
   * runner shows it to the person and answers right away (`pending`, or
   * `granted` when that folder is already allowed for this agent); the
   * decision comes later as `access.decided`.
   */
  | { op: "access.request"; requestId: string; path: string; reason: string }
  /** Protocol 10: the site removed a folder (for everyone, or for one agent) or turned a tool off. Never widens. */
  | {
      op: "access.reduce";
      removeFolder?: { path: string; agentId?: string };
      disableTool?: keyof RunnerTools;
    }
  | {
      op: "push";
      path: string;
      /** Absolute URL of our upload endpoint (`PUT`, machine token as bearer). */
      url: string;
      uploadId: string;
      maxBytes: number;
    }
  /**
   * Protocol 12: one `agent-browser` command in the request's agent's session
   * (`open`, `snapshot`, `click`…; `args` as on its command line, without
   * `--session`, `--profile` or `--json`, which the runner sets). Commands run
   * one at a time per session. `allowedDomains`: the agent's site allowlist.
   */
  | {
      op: "browser.act";
      command: string;
      args: string[];
      timeoutSeconds: number;
      allowedDomains?: string[];
      /** The conversation the command is for (`/org/…/c/…`): the desktop app's "Ver" opens it. */
      link?: string;
    }
  /** Protocol 12: close the agent's browser session (Stop, idle). */
  | { op: "browser.stop" }
  /** Protocol 12: start (or change the mode of) the agent's stream: `browser.frame` frames until `browser.stream.stop`. */
  | { op: "browser.stream.start"; mode: BrowserStreamMode }
  | { op: "browser.stream.stop" }
  /** Protocol 12: a person's input during a take over, in order. */
  | { op: "browser.input"; events: BrowserInputEvent[] }
) & { agent?: AgentScope };

export type MachineOp = MachineRequest["op"];

export const MACHINE_OPS: readonly MachineOp[] = [
  "exec",
  "read",
  "write",
  "list",
  "push",
  "secret",
  "account",
  "task.start",
  "task.status",
  "task.cancel",
  "task.output",
  "brain.turn",
  "brain.steer",
  "git.sync",
  "mission.worktree",
  "access.request",
  "access.reduce",
  "browser.act",
  "browser.stop",
  "browser.stream.start",
  "browser.stream.stop",
  "browser.input",
];

/** What each op answers with `ok: true`. */
export interface MachineReplies {
  exec: { exitCode: number; stdout: string; stderr: string; timedOut: boolean; canceled?: { killed: boolean } };
  /** `base64: null`: no such file. */
  read: { base64: string | null; size: number };
  write: { size: number };
  list: { entries: FileEntry[] };
  /** What was sent: the uploaded name (`report.pdf`, or `folder.zip`), bytes and SHA-256 (hex). */
  push: { name: string; size: number; sha256: string; contentType: string };
  /** `keypair`: the public key (raw P-256, base64); `deliver`: the value's size in bytes. */
  secret: { publicKey?: string; size?: number };
  /**
   * `begin`: what the person needs (`url`; Claude Code: `publicKey`; Codex: `userCode`);
   * `status`: `state` and, when done, `account`; `list`: `accounts`; `code`, `cancel`, `remove`: `{}`.
   */
  account: {
    url?: string;
    userCode?: string;
    publicKey?: string;
    state?: AccountLoginState;
    account?: RunnerAccountInfo;
    accounts?: RunnerAccountInfo[];
    /** `failed`: why, for people. */
    error?: string;
  };
  /** `cwd`: where it runs, relative to the agent's folder (`.worktrees/<taskId>` with a branch). */
  "task.start": {
    taskId: string;
    pid: number;
    startedAt: string;
    cwd: string;
    branch?: string;
    command: string;
    /** Protocol 14, with `baseCheck`: commits the base branch has beyond the mission's base (absent: unknown). */
    baseBehind?: number;
  };
  "task.status": { tasks: RunnerTask[] };
  /** `false`: it had already ended. */
  "task.cancel": { canceled: boolean };
  /** Oldest first; `truncated`: the log had more than was read. */
  "task.output": { lines: string[]; truncated: boolean };
  /** `final`: the turn's last event (`done` or `error`), also streamed. */
  "brain.turn": { runId: string; final: WireBrainEvent };
  "brain.steer": BrainSteerReply;
  "git.sync": { repos: GitSyncRepo[] };
  /** `remove` answers `{ removed }` (`false`: the folder was already gone). */
  "mission.worktree": Partial<MissionWorktreeEnsured> & { removed?: boolean };
  "access.request": { requestId: string; status: "pending" | "granted" };
  "access.reduce": { access: RunnerAccess };
  /** `agent-browser`'s own JSON answer: `success: false` with its `error` is a page-level failure (stale ref, covered click). */
  "browser.act": { success: boolean; data: unknown; error?: string };
  /** `false`: there was no session. */
  "browser.stop": { stopped: boolean };
  "browser.stream.start": { mode: BrowserStreamMode };
  "browser.stream.stop": { stopped: boolean };
  /** Events sent to the page. */
  /** `failed`: events the browser didn't confirm (absent when all went through). */
  "browser.input": { accepted: number; failed?: number };
}

/** Error codes the runner reports; the message is for people. */
export type MachineErrorCode =
  | "not_found"
  | "outside_workspace"
  | "exec_disabled"
  | "too_large"
  | "upload_failed"
  /** `task.start` beyond the runner's concurrent tasks (`maxConcurrentTasks`). */
  | "no_slot"
  /** Protocol 9: the owner paused this computer; nothing new starts until it resumes. */
  | "paused"
  /** Protocol 10: the path is outside every folder this agent may use, or the tool is off on the machine. */
  | "not_allowed"
  /** Protocol 12: the agent browser can't run here (no binary, no Chrome, too many sessions); the message says why. */
  | "browser_unavailable"
  /** Protocol 14: `mission.worktree` `ensure` with `baseSha` found neither the folder nor the branch. */
  | "branch_missing"
  /**
   * Protocol 14: `mission.worktree` on a folder that is in no git repository at
   * all (the mission works in it with no branch). A folder inside a repository
   * whose top level is outside the agent's folder is `outside_workspace`.
   */
  | "not_git"
  | "bad_request"
  | "internal";

/** Server → runner. */
export type ServerFrame =
  | { type: "welcome"; machineId: string; name: string; heartbeatMs: number }
  | ({ type: "request"; id: string } & MachineRequest)
  | { type: "cancel"; id: string }
  | { type: "ping"; at: number }
  /** The server stored this task's `task.done`: the runner stops re-sending it. */
  | { type: "task.ack"; taskId: string }
  /** Protocol 5: the answer to an `mcp.call` (the text the executor's tool call returns). */
  | { type: "mcp.result"; callId: string; ok: true; text: string }
  | { type: "mcp.result"; callId: string; ok: false; error: { code: string; message: string } }
  /** Protocol 8: the answer to an `mcp.list`: the tools this run may use (JSON Schemas simplified for the CLIs). */
  | { type: "mcp.tools"; callId: string; ok: true; tools: McpToolInfo[] }
  | { type: "mcp.tools"; callId: string; ok: false; error: { code: string; message: string } }
  /**
   * Protocol 9: the agents of the organization that use this machine (pointed
   * at it), sent after `welcome` and again whenever the list or a name/look
   * changes. The runner shows them in the desktop app.
   */
  | { type: "agents"; agents: MachineAgent[] }
  /**
   * Protocol 12: a request for help or a person in control in an agent's
   * browser started, changed or ended (`handoff: null`); sent again on
   * reconnect for the ones still open. The desktop app shows it. Older
   * runners ignore it.
   */
  | { type: "browser.handoff"; agentId: string; handoff: BrowserHandoffInfo | null }
  /** The server closes after sending this (bad token, revoked, outdated runner). */
  | { type: "refused"; reason: "invalid_token" | "revoked" | "outdated" | "replaced"; message: string };

/** Runner → server. */
export type RunnerFrame =
  | ({ type: "hello"; token: string } & RunnerInfo)
  | { type: "output"; id: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: { code: MachineErrorCode; message: string } }
  | { type: "pong"; at: number }
  /** A task's progress: a human last line, files it touched, or elapsed time (throttled). */
  | {
      type: "task.event";
      taskId: string;
      kind: "line" | "files" | "progress";
      line?: string;
      files?: string[];
      seconds?: number;
      /** Protocol 6: a pull request URL seen in the task's output (`gh pr create`, a tool result). */
      prUrl?: string;
    }
  | ({ type: "task.done" } & TaskDone)
  /**
   * Protocol 5: the executor of a mission task called a tool of the local
   * `agentes` MCP server. The server checks the task belongs to this machine
   * and to a mission, runs the tool and answers `mcp.result`.
   */
  | {
      type: "mcp.call";
      callId: string;
      taskId: string;
      tool: string;
      args: Record<string, unknown>;
      /** Protocol 8: the server-issued token of the task or run (ADR 0032); without it, the legacy mission path. */
      token?: string;
    }
  /** Protocol 8: the bridge asks which tools this run may use (`tools/list`); answered with `mcp.tools`. */
  | { type: "mcp.list"; callId: string; taskId: string; token: string }
  /** Protocol 8: one event of a running `brain.turn`. */
  | { type: "brain.event"; runId: string; event: WireBrainEvent }
  /** Protocol 8: a `brain.turn` sent its last event. */
  | { type: "brain.done"; runId: string }
  /** Protocol 9: the pause state changed on the machine (paused, resumed, new `until`). */
  | { type: "runner.state"; paused: RunnerPause }
  /** Protocol 10: what the machine allows changed (the person granted, removed, or turned a tool on or off). */
  | { type: "access.changed"; access: RunnerAccess }
  /** Protocol 13: the accounts on the machine changed (signed in or removed from the desktop app, a sign-in done, a status changed). */
  | { type: "accounts.changed"; accounts: RunnerAccountInfo[] }
  /**
   * Protocol 10: the person answered an `access.request` on the machine (or it
   * expired). `granted` also comes with an `access.changed`.
   */
  | {
      type: "access.decided";
      requestId: string;
      decision: "granted" | "denied" | "expired";
      /** Granted for this agent only, or for every agent of the organization on this machine. */
      scope?: "agent" | "all";
    }
  /** Protocol 12: one image of an agent's browser while its stream is on (newest wins; the server never stores it). */
  | { type: "browser.frame"; agentId: string; seq: number; data: string; metadata: BrowserFrameMetadata }
  /** Protocol 12: an agent's stream stopped on the machine (asked, session closed, error). */
  | { type: "browser.stream.ended"; agentId: string; reason: "stopped" | "closed" | "error"; message?: string };

/** A tool as `mcp.tools` lists it (what MCP `tools/list` returns). */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Most tools one `mcp.tools` frame carries. */
export const MCP_TOOLS_MAX = 200;

/** Largest `mcp.call` arguments (JSON characters). */
export const MCP_ARGS_MAX_CHARS = 64 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";
const cut = (v: unknown, max: number) => (isString(v) ? v.slice(0, max) : undefined);
const fileList = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter(isString)
        .slice(0, TASK_LIMITS.files)
        .map((p) => p.slice(0, TASK_LIMITS.filePath))
    : undefined;
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A full or short git commit id (lowercase hex). */
export const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,64}$/.test(v);

/** Protocol 14: `task.start`'s `baseBehind` (a count of commits; absent when the runner couldn't tell). */
export function parseBaseBehind(data: unknown): number | undefined {
  const n = isObject(data) ? data.baseBehind : undefined;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Protocol 14: a `mission.worktree` `ensure` answer, checked (null when it isn't one). */
export function parseMissionWorktreeEnsured(data: unknown): MissionWorktreeEnsured | null {
  if (!isObject(data) || !isString(data.path) || !isString(data.branch) || typeof data.created !== "boolean") {
    return null;
  }
  return {
    path: data.path.slice(0, 500),
    branch: data.branch.slice(0, 200),
    baseBranch: isString(data.baseBranch) ? data.baseBranch.slice(0, 200) : "",
    baseSha: isSha(data.baseSha) ? data.baseSha : "",
    created: data.created,
    dirty: data.dirty === true,
    setupCommand: isString(data.setupCommand) && data.setupCommand.trim() ? data.setupCommand.slice(0, 2000) : null,
    copied: Array.isArray(data.copied)
      ? data.copied
          .filter(isString)
          .slice(0, 100)
          .map((p) => p.slice(0, 300))
      : [],
  };
}

/** `task.done.denials`: at most `TASK_LIMITS.denials`, each cut, duplicates dropped. */
const denialList = (v: unknown): TaskDenial[] => {
  if (!Array.isArray(v)) return [];
  const out: TaskDenial[] = [];
  for (const d of v) {
    if (!isObject(d) || !isString(d.command) || !d.command.trim()) continue;
    const tool = isString(d.tool) && d.tool ? d.tool.slice(0, 64) : "Bash";
    const command = d.command.trim().slice(0, TASK_LIMITS.denial);
    if (out.some((x) => x.tool === tool && x.command === command)) continue;
    out.push({ tool, command });
    if (out.length >= TASK_LIMITS.denials) break;
  }
  return out;
};

/** `hello.executors`: only `claude` and `codex`, each with a short version line (and Claude Code's login). */
export function parseExecutors(v: Record<string, unknown>): NonNullable<RunnerInfo["executors"]> {
  const out: NonNullable<RunnerInfo["executors"]> = {};
  const word = (x: unknown) => (isString(x) && /^[\w.-]{1,40}$/.test(x) ? x : undefined);
  for (const name of ["claude", "codex"] as const) {
    const e = v[name];
    if (!isObject(e) || !isString(e.version)) continue;
    const authMethod = word(e.authMethod);
    const plan = word(e.plan);
    out[name] = {
      version: e.version.replace(/\s+/g, " ").trim().slice(0, 80),
      ...(typeof e.loggedIn === "boolean" ? { loggedIn: e.loggedIn } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(plan ? { plan } : {}),
    };
  }
  return out;
}

/** `hello.accounts` (protocol 13): at most `MAX_MACHINE_ACCOUNTS`, ids and kinds checked, short words only. */
export function parseAccounts(v: unknown[]): RunnerAccountInfo[] {
  const out: RunnerAccountInfo[] = [];
  for (const a of v.slice(0, MAX_MACHINE_ACCOUNTS)) {
    if (!isObject(a) || !isAccountId(a.id) || !isAccountKind(a.kind)) continue;
    const email = isString(a.email) && a.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(a.email) ? a.email : undefined;
    const plan = isString(a.plan) && /^[\w.-]{1,40}$/.test(a.plan) ? a.plan : undefined;
    out.push({
      id: a.id,
      kind: a.kind,
      loggedIn: a.loggedIn === true,
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
    });
  }
  return out;
}

const cutJson = (v: unknown, max: number): unknown => {
  try {
    const text = JSON.stringify(v ?? null);
    return text.length <= max ? v : { truncated: text.slice(0, max) };
  } catch {
    return null;
  }
};

/** One `brain.event` event, checked and cut; null when it isn't one. */
export function parseBrainEvent(v: unknown): WireBrainEvent | null {
  if (!isObject(v) || !isString(v.type)) return null;
  const num = (x: unknown) => Math.max(0, Math.round(finite(x) ?? 0));
  switch (v.type) {
    case "text_delta":
      return isString(v.text) ? { type: "text_delta", text: v.text.slice(0, BRAIN_LIMITS.delta) } : null;
    case "tool_call": {
      if (!isString(v.id) || !isString(v.name)) return null;
      const ex = isObject(v.executed) && isString(v.executed.content) ? v.executed : null;
      return {
        type: "tool_call",
        id: v.id.slice(0, 128),
        name: v.name.slice(0, BRAIN_LIMITS.toolName),
        input: cutJson(v.input, BRAIN_LIMITS.toolText),
        ...(ex
          ? {
              executed: {
                content: String(ex.content).slice(0, BRAIN_LIMITS.toolText),
                ...(ex.isError === true ? { isError: true } : {}),
              },
            }
          : {}),
      };
    }
    case "usage":
      return {
        type: "usage",
        input: num(v.input),
        output: num(v.output),
        source: v.source === "api" ? "api" : "plan",
        ...(isString(v.model) ? { model: v.model.slice(0, 100) } : {}),
        ...(num(v.cacheRead) > 0 ? { cacheRead: num(v.cacheRead) } : {}),
        ...(num(v.cacheWrite) > 0 ? { cacheWrite: num(v.cacheWrite) } : {}),
      };
    case "limit":
      return { type: "limit", ...(isString(v.resetsAt) ? { resetsAt: v.resetsAt.slice(0, 40) } : {}) };
    case "done": {
      if (!isString(v.text)) return null;
      const session = isObject(v.session) && isString(v.session.id) ? { id: v.session.id.slice(0, 64) } : undefined;
      return { type: "done", text: v.text.slice(0, BRAIN_LIMITS.doneText), ...(session ? { session } : {}) };
    }
    case "error":
      if (!isString(v.code)) return null;
      return {
        type: "error",
        code: v.code.slice(0, 64),
        message: (isString(v.message) ? v.message : "").slice(0, BRAIN_LIMITS.message),
        ...(typeof v.retryable === "boolean" ? { retryable: v.retryable } : {}),
      };
    case "steer_read": {
      if (!Array.isArray(v.uuids)) return null;
      const uuids = v.uuids
        .filter(isString)
        .slice(0, STEER_LIMITS.messages * 4)
        .map((u) => u.slice(0, 64));
      return uuids.length ? { type: "steer_read", uuids } : null;
    }
    default:
      return null;
  }
}

/** A journal entry from `hello` or `task.status`; null when malformed. */
export function parseRunnerTask(v: unknown): RunnerTask | null {
  if (!isObject(v) || !isString(v.taskId) || !isString(v.agentId) || !isString(v.startedAt)) return null;
  const status = (["running", "done", "interrupted"] as const).find((s) => s === v.status);
  if (!status) return null;
  const exitCode = v.exitCode === null ? null : finite(v.exitCode);
  return {
    taskId: v.taskId.slice(0, 64),
    agentId: v.agentId.slice(0, 64),
    status,
    ...(finite(v.pid) !== undefined ? { pid: finite(v.pid) } : {}),
    startedAt: v.startedAt.slice(0, 40),
    ...(isString(v.endedAt) ? { endedAt: v.endedAt.slice(0, 40) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(v.signal === null || isString(v.signal) ? { signal: v.signal === null ? null : v.signal.slice(0, 20) } : {}),
    ...(finite(v.seconds) !== undefined ? { seconds: finite(v.seconds) } : {}),
    ...(isString(v.lastLine) ? { lastLine: v.lastLine.slice(0, TASK_LIMITS.line) } : {}),
    ...(fileList(v.files) ? { files: fileList(v.files) } : {}),
  };
}

/** Parses a runner frame (server side); null when it isn't one. */
export function parseRunnerFrame(raw: string): RunnerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(f)) return null;
  switch (f.type) {
    case "hello": {
      if (!isString(f.token) || !isString(f.version) || typeof f.protocol !== "number") return null;
      const paused = parsePause(f.paused);
      const access = parseAccess(f.access);
      return {
        type: "hello",
        token: f.token,
        version: f.version.slice(0, 40),
        protocol: f.protocol,
        os: (["linux", "darwin", "windows"] as const).find((o) => o === f.os) ?? "other",
        arch: isString(f.arch) ? f.arch.slice(0, 40) : "",
        hostname: isString(f.hostname) ? f.hostname.slice(0, 200) : "",
        workspace: isString(f.workspace) ? f.workspace.slice(0, 500) : "",
        exec: f.exec !== false,
        ...(isObject(f.executors) ? { executors: parseExecutors(f.executors) } : {}),
        ...(Array.isArray(f.tasks)
          ? {
              tasks: f.tasks
                .slice(0, TASK_LIMITS.tasks)
                .map(parseRunnerTask)
                .filter((t): t is RunnerTask => t !== null),
            }
          : {}),
        ...(paused ? { paused } : {}),
        ...(access ? { access } : {}),
        ...(isObject(f.browser) ? { browser: parseBrowserInfo(f.browser) } : {}),
        ...(Array.isArray(f.accounts) ? { accounts: parseAccounts(f.accounts) } : {}),
      };
    }
    case "browser.frame": {
      if (!isString(f.agentId) || !isString(f.data) || f.data.length > BROWSER_LIMITS.frameBytes) return null;
      const seq = finite(f.seq);
      const m = isObject(f.metadata) ? f.metadata : null;
      const width = finite(m?.deviceWidth);
      const height = finite(m?.deviceHeight);
      if (seq === undefined || !m || width === undefined || height === undefined) return null;
      const scale = finite(m.pageScaleFactor);
      const url = cut(m.url, BROWSER_LIMITS.url);
      return {
        type: "browser.frame",
        agentId: f.agentId.slice(0, 64),
        seq,
        data: f.data,
        metadata: {
          deviceWidth: width,
          deviceHeight: height,
          ...(scale !== undefined ? { pageScaleFactor: scale } : {}),
          ...(url !== undefined ? { url } : {}),
        },
      };
    }
    case "browser.stream.ended": {
      if (!isString(f.agentId)) return null;
      const reason = (["stopped", "closed", "error"] as const).find((r) => r === f.reason);
      if (!reason) return null;
      const message = cut(f.message, BROWSER_LIMITS.message);
      return {
        type: "browser.stream.ended",
        agentId: f.agentId.slice(0, 64),
        reason,
        ...(message !== undefined ? { message } : {}),
      };
    }
    case "runner.state": {
      const paused = parsePause(f.paused);
      return paused ? { type: "runner.state", paused } : null;
    }
    case "access.changed": {
      const access = parseAccess(f.access);
      return access ? { type: "access.changed", access } : null;
    }
    case "accounts.changed":
      return Array.isArray(f.accounts) ? { type: "accounts.changed", accounts: parseAccounts(f.accounts) } : null;
    case "access.decided": {
      if (!isString(f.requestId)) return null;
      const decision = (["granted", "denied", "expired"] as const).find((d) => d === f.decision);
      if (!decision) return null;
      const scope = (["agent", "all"] as const).find((s) => s === f.scope);
      return {
        type: "access.decided",
        requestId: f.requestId.slice(0, 64),
        decision,
        ...(scope ? { scope } : {}),
      };
    }
    case "output":
      if (!isString(f.id) || !isString(f.chunk) || (f.stream !== "stdout" && f.stream !== "stderr")) return null;
      return { type: "output", id: f.id, stream: f.stream, chunk: f.chunk };
    case "result":
      if (!isString(f.id)) return null;
      if (f.ok === true) return { type: "result", id: f.id, ok: true, data: f.data };
      if (f.ok === false && isObject(f.error) && isString(f.error.code) && isString(f.error.message)) {
        return {
          type: "result",
          id: f.id,
          ok: false,
          error: { code: f.error.code as MachineErrorCode, message: f.error.message.slice(0, 2000) },
        };
      }
      return null;
    case "pong":
      return typeof f.at === "number" ? { type: "pong", at: f.at } : null;
    case "task.event": {
      if (!isString(f.taskId) || (f.kind !== "line" && f.kind !== "files" && f.kind !== "progress")) return null;
      const line = cut(f.line, TASK_LIMITS.line);
      const files = fileList(f.files);
      const seconds = finite(f.seconds);
      const prUrl = cut(f.prUrl, TASK_LIMITS.prUrl);
      return {
        type: "task.event",
        taskId: f.taskId.slice(0, 64),
        kind: f.kind,
        ...(line !== undefined ? { line } : {}),
        ...(files ? { files } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(prUrl && /^https?:\/\/\S+$/i.test(prUrl) ? { prUrl } : {}),
      };
    }
    case "task.done": {
      if (!isString(f.taskId)) return null;
      const exitCode = finite(f.exitCode) ?? null;
      const result = cut(f.result, TASK_LIMITS.result);
      const lastLine = cut(f.lastLine, TASK_LIMITS.line);
      const files = fileList(f.files);
      const session = cut(f.session, 64);
      const denials = denialList(f.denials);
      // Protocol 14: both or neither.
      const shas = isSha(f.startSha) && isSha(f.endSha) ? { startSha: f.startSha, endSha: f.endSha } : {};
      return {
        type: "task.done",
        taskId: f.taskId.slice(0, 64),
        exitCode,
        signal: isString(f.signal) ? f.signal.slice(0, 20) : null,
        seconds: Math.max(0, Math.round(finite(f.seconds) ?? 0)),
        ...(result !== undefined ? { result } : {}),
        ...(lastLine !== undefined ? { lastLine } : {}),
        ...(files ? { files } : {}),
        ...(f.canceled === true ? { canceled: true } : {}),
        ...(f.timedOut === true ? { timedOut: true } : {}),
        ...(f.interrupted === true ? { interrupted: true } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(denials.length ? { denials } : {}),
        ...shas,
      };
    }
    case "mcp.call": {
      if (!isString(f.callId) || !isString(f.taskId) || !isString(f.tool)) return null;
      const args = isObject(f.args) && !Array.isArray(f.args) ? f.args : {};
      if (JSON.stringify(args).length > MCP_ARGS_MAX_CHARS) return null;
      return {
        type: "mcp.call",
        callId: f.callId.slice(0, 64),
        taskId: f.taskId.slice(0, 64),
        tool: f.tool.slice(0, 64),
        args,
        ...(isRunToolToken(f.token) ? { token: f.token } : {}),
      };
    }
    case "mcp.list":
      if (!isString(f.callId) || !isString(f.taskId) || !isRunToolToken(f.token)) return null;
      return { type: "mcp.list", callId: f.callId.slice(0, 64), taskId: f.taskId.slice(0, 64), token: f.token };
    case "brain.event": {
      if (!isString(f.runId)) return null;
      const event = parseBrainEvent(f.event);
      return event ? { type: "brain.event", runId: f.runId.slice(0, 64), event } : null;
    }
    case "brain.done":
      return isString(f.runId) ? { type: "brain.done", runId: f.runId.slice(0, 64) } : null;
    default:
      return null;
  }
}

const SERVER_FRAME_TYPES = [
  "welcome",
  "request",
  "cancel",
  "ping",
  "refused",
  "task.ack",
  "mcp.result",
  "mcp.tools",
  "agents",
  "browser.handoff",
];

/** Parses a server frame (runner side); null when it isn't one. */
export function parseServerFrame(raw: string): ServerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(f) || !isString(f.type)) return null;
  if (f.type === "request") {
    if (!isString(f.id) || !isString(f.op)) return null;
    if (!MACHINE_OPS.includes(f.op as MachineOp)) return null;
  }
  if ((f.type === "cancel" || f.type === "request") && !isString(f.id)) return null;
  if (f.type === "task.ack" && !isString(f.taskId)) return null;
  if ((f.type === "mcp.result" || f.type === "mcp.tools") && !isString(f.callId)) return null;
  if (f.type === "mcp.tools" && f.ok === true && !Array.isArray(f.tools)) return null;
  if (f.type === "agents" && !Array.isArray(f.agents)) return null;
  if (f.type === "browser.handoff" && (!isString(f.agentId) || (f.handoff !== null && !isObject(f.handoff)))) {
    return null;
  }
  if (!SERVER_FRAME_TYPES.includes(f.type)) return null;
  return f as ServerFrame;
}

/** A pairing code as people type it: 8 letters/digits, dash optional, any case. */
export function normalizePairingCode(code: string) {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The tools of the local `agentes` MCP server a mission task's executor gets
 * (protocol 5, ADR 0029). The runner lists them (`tools/list`) and relays
 * calls; the server validates and runs them, bound to the task's mission.
 */
export interface MissionMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const RULES_START =
  "You work on an agentes.chat mission. Read the files in .agentes/ first (mission.md, decisions.md, notes.md). Use the agentes tools: keep the plan with update_plan, report milestones with report, ask decisions only with ask_decision, and ask for a review with request_review when you have something to show. Write plan items, reports, decisions and reviews in the language the people use in the thread (the language of the mission goal), short and plain.";
const RULES_END =
  "Plan items are short outcomes in the people's language; never put tool names (request_review, upload_artifact and the like) in them. When every plan item is done, call complete_mission with what you delivered and what the person should check; don't keep working. Write what you learn and the next steps in .agentes/notes.md. When a tool tells you to stop and wait, end your turn.";

/**
 * What a mission's executor is told on every task (ADR 0029) when its folder
 * is a git repository: appended to Claude Code's system prompt
 * (`--append-system-prompt`) and written in `.agentes/mission.md`. Plain
 * characters only: the runner passes it as one shell argument (`cleanRules`).
 */
export const MISSION_RULES = `${RULES_START} Never merge, deploy or roll back directly: ask with request_approval and wait. Work on the mission's own branch in the mission's folder (don't create or switch branches), commit work in progress after each step and push the branch now and then. ${RULES_END}`;

/**
 * The same rules for a mission folder that is not a git repository (images,
 * documents, files for the Drive): no branches, commits, pull requests or
 * pushes; results go to the people with upload_artifact or request_review.
 * The runner picks this one when the task's folder isn't a repository.
 */
export const MISSION_RULES_NO_GIT = `${RULES_START} Never deploy or publish anything directly: ask with request_approval and wait. This mission folder is not a git repository and doesn't need one: don't create one. Work in the mission folder (items started with start_task work there too, one that writes at a time), and deliver results with upload_artifact or request_review. ${RULES_END}`;

const PLAN_STATUSES = ["todo", "doing", "waiting_you", "done", "dropped"];

export const MISSION_MCP_TOOLS: readonly MissionMcpTool[] = [
  {
    name: "report",
    description:
      "Tell the people in the mission's thread where things stand: a milestone, what you found, what is next. One short paragraph in the language the people use in the thread; no internal details (tool names, logs). Use it at milestones, not for every step. pr_url: a pull request you opened.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        status: { enum: ["working", "blocked", "done"] },
        pr_url: { type: "string", maxLength: 500 },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "update_plan",
    description:
      "Replace the mission's plan: the whole checklist, every time (keep each item's id stable). Statuses: todo, doing, waiting_you (needs a person), done, dropped. Write titles and notes in the language the people use in the thread, short (a title is at most 200 characters; details go in note). Keep an item's title unless what it means changed. People see each change as one line in the thread.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 60,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 40 },
              title: { type: "string", minLength: 1, maxLength: 200 },
              status: { enum: PLAN_STATUSES },
              note: { type: "string", maxLength: 500 },
            },
            required: ["title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_decision",
    description:
      "Ask the people a product or technical decision as a card with 2 to 4 options, in the language the people use in the thread. blocking: true when you can't go on without it (then stop and wait; you are resumed with the answer). blocking: false to go on with your recommendation as a provisional decision they review later.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 500 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        recommendation: { type: "string", maxLength: 200 },
        why: { type: "string", maxLength: 1000 },
        impact: { type: "string", maxLength: 500 },
        blocking: { type: "boolean" },
      },
      required: ["question", "options", "blocking"],
      additionalProperties: false,
    },
  },
  {
    name: "request_review",
    description:
      "Ask the people to look at something you can show (screens, files, a prototype, a PR), with the title and summary in the language the people use in the thread. paths: files in your folder to attach (uploaded to the Drive). Then stop and wait: you are resumed with their answer (approved, or the changes they want).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        summary: { type: "string", maxLength: 4000 },
        pr_url: { type: "string", maxLength: 500 },
        paths: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 300 } },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "request_approval",
    description:
      "Ask a person to approve a merge, a deploy or a rollback before you do it. Never merge, deploy or roll back without an approval. Then stop and wait: you are resumed with the outcome.",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["merge", "deploy", "rollback"] },
        target: { type: "string", minLength: 1, maxLength: 300 },
        detail: { type: "string", maxLength: 1000 },
      },
      required: ["action", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_artifact",
    description:
      "Send a file (or a folder, as a .zip) from your folder to the team's Drive and get its id. The bytes go straight to the Drive.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 300 },
        title: { type: "string", maxLength: 200 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "get_context",
    description:
      "Search what the organization already knows (conversations, decisions, wiki, documents) that this mission's agent may see. Short results.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "start_task",
    description:
      'Main session only: start one plan item as its own background session in the mission\'s folder (the mission\'s own copy of the project, on its branch). mode "write" (default): it may change files; write items run one at a time, in the order you start them (one started while another runs waits in a queue and starts by itself), and each ends in one commit you are told about. mode "read": research, analysis or review with no write access; read items may run in parallel. An item that finds the computer full waits in the queue too. You are told when it ends. Give it everything it needs in prompt. Small work you can just do yourself.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        prompt: { type: "string", minLength: 1, maxLength: 20000 },
        mode: { enum: ["write", "read"] },
      },
      required: ["title", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_mission",
    description:
      "When every plan item is done: hand the mission over to the people as a delivery card. summary: what you delivered, in the language the people use in the thread. checklist: what the person should check (short items). paths: files in your folder to attach (uploaded to the Drive). Then stop and wait: the person concludes the mission or asks for changes (you are resumed with them). Don't keep working.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        checklist: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } },
        paths: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 300 } },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "permission_prompt",
    description:
      "Internal: Claude Code calls this itself when a command needs a person's approval (--permission-prompt-tool). Never call it yourself.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", maxLength: 64 },
        input: { type: "object" },
        tool_use_id: { type: "string", maxLength: 128 },
        /** The runner's follow-up: the state of a request it already made. */
        request_id: { type: "string", maxLength: 64 },
        /** Added by the runner: where the task runs and its folders (the code-side rules check paths). */
        scope: { type: "object" },
      },
    },
  },
];

/**
 * The first pull (or merge) request URL in a text: GitHub `…/pull/N`,
 * GitLab `…/-/merge_requests/N`. Shared by the runner (task output) and the
 * server (lines, results, the executor's reports).
 */
export function findPullRequestUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+\/(?:[\w.-]+\/)+-\/merge_requests\/\d+)/.exec(
    text,
  );
  return m ? m[0].slice(0, TASK_LIMITS.prUrl) : null;
}

// ── Command approvals (Claude Code's permission prompts) ──────────────────────

/** Our MCP tool Claude Code asks when a command needs a person (`--permission-prompt-tool`). */
export const PERMISSION_TOOL = "permission_prompt";
/** Its name as Claude Code knows it. */
export const PERMISSION_PROMPT_TOOL = `mcp__agentes__${PERMISSION_TOOL}`;
/** How long a command waits for a person before it is denied. */
export const PERMISSION_WAIT_MS = 30 * 60_000;
/** How often the runner asks the server whether someone answered. */
export const PERMISSION_POLL_MS = 4000;
/** Told to the executor when nobody answered in time. */
export const PERMISSION_TIMEOUT_MESSAGE =
  "The person was asked and didn't answer yet; continue with other work or stop and wait.";

/** The words a command is made of: one per part of a pipeline or list (`a && b | c`). */
export function commandParts(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** What a tool call does, as one line for people (`git init`, `WebFetch https://…`). */
export function commandOf(toolName: string, input: Record<string, unknown> | null | undefined): string {
  const i = input ?? {};
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (toolName === "Bash") return s("command").trim().replace(/\s+/g, " ").slice(0, 1000);
  const what = s("url") || s("file_path") || s("path") || s("query") || s("pattern");
  return `${toolName}${what ? ` ${what}` : ""}`.slice(0, 1000);
}

const globRe = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

/** The `Bash(...)` pattern of a rule, or null for another tool's rule. */
const bashPattern = (rule: string) => /^Bash\((.*)\)$/s.exec(rule.trim())?.[1] ?? null;

/** One part of a command against one `Bash(...)` pattern (Claude Code's `*` matches anything; `x *` also matches `x`). */
function partMatches(pattern: string, part: string) {
  if (globRe(pattern).test(part)) return true;
  return pattern.endsWith(" *") && part === pattern.slice(0, -2);
}

/**
 * Does a permission rule cover this call? `Bash(...)` rules: a deny rule
 * matches when any part of the command matches (`mode: "any"`), an allow
 * rule set covers a command when every part matches one of them (see
 * `allowedBy`). Other tools: the bare name, or `WebFetch(domain:host)`.
 */
export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown> | null | undefined) {
  const pattern = bashPattern(rule);
  if (pattern !== null) {
    if (toolName !== "Bash") return false;
    return commandParts(commandOf("Bash", input)).some((part) => partMatches(pattern, part));
  }
  const r = rule.trim();
  if (r === toolName) return true;
  const domain = /^WebFetch\(domain:(.+)\)$/.exec(r)?.[1];
  if (domain && toolName === "WebFetch") {
    try {
      return new URL(String(input?.url ?? "")).hostname === domain;
    } catch {
      return false;
    }
  }
  return false;
}

/** Every part of the call is covered by one of these allow rules. */
export function allowedBy(
  rules: readonly string[],
  toolName: string,
  input: Record<string, unknown> | null | undefined,
) {
  if (toolName !== "Bash") return rules.some((r) => ruleMatches(r, toolName, input));
  const parts = commandParts(commandOf("Bash", input));
  if (parts.length === 0) return false;
  return parts.every((part) =>
    rules.some((r) => {
      const pattern = bashPattern(r);
      return pattern !== null && partMatches(pattern, part);
    }),
  );
}

/** Tools whose rules keep two words (`git init`, `npm run`): the rest keep one (`swift`, `python3`). */
const TWO_WORD_COMMANDS = new Set([
  "git",
  "gh",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "brew",
  "pip",
  "pip3",
  "uv",
  "xcrun",
  "swift",
  "eas",
  "npx",
]);

/**
 * "Aprovar sempre nesta missão": the rules that allow this call from now on,
 * from the first word (or two) of each part (`swift build -c release` →
 * `Bash(swift build *)`; `sips -Z 800 a.png` → `Bash(sips *)`); another
 * tool: its name (WebFetch: its domain). At most 5.
 */
export function rulesFor(toolName: string, input: Record<string, unknown> | null | undefined): string[] {
  if (toolName === "Bash") {
    const out: string[] = [];
    for (const part of commandParts(commandOf("Bash", input))) {
      const words = part.split(" ").filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
      const first = words[0];
      if (!first) continue;
      const second = words[1];
      const head = TWO_WORD_COMMANDS.has(first) && second && !second.startsWith("-") ? `${first} ${second}` : first;
      const rule = `Bash(${head.replace(/[()*]/g, "")} *)`;
      if (!out.includes(rule)) out.push(rule);
      if (out.length >= 5) break;
    }
    return out;
  }
  if (toolName === "WebFetch") {
    try {
      return [`WebFetch(domain:${new URL(String(input?.url ?? "")).hostname})`];
    } catch {
      return ["WebFetch"];
    }
  }
  return /^[A-Za-z_][\w]*$/.test(toolName) ? [toolName] : [];
}

/** A rule we accept from the server for a task's settings (no wildcards for whole tools, no odd characters). */
export const isSafeRule = (rule: string) =>
  /^Bash\([^()\n]{1,200}\)$/.test(rule) ||
  /^WebFetch\(domain:[\w.-]{1,200}\)$/.test(rule) ||
  /^(WebFetch|WebSearch)$/.test(rule);

/** `hello.paused` / `runner.state.paused`, checked. */
export function parsePause(v: unknown): RunnerPause | undefined {
  if (!isObject(v) || typeof v.paused !== "boolean") return undefined;
  const until = isString(v.until) && !Number.isNaN(Date.parse(v.until)) ? new Date(v.until).toISOString() : null;
  return v.paused ? { paused: true, until } : { paused: false };
}

/** `hello.access` / `access.changed.access`, checked and cut. */
export function parseAccess(v: unknown): RunnerAccess | undefined {
  if (!isObject(v) || !isObject(v.tools) || !Array.isArray(v.folders)) return undefined;
  const t = v.tools;
  const folders: RunnerFolderGrant[] = [];
  for (const f of v.folders.slice(0, ACCESS_LIMITS.folders)) {
    if (!isObject(f) || !isString(f.path) || !f.path) continue;
    const agents = Array.isArray(f.agents)
      ? f.agents
          .filter(isString)
          .slice(0, ACCESS_LIMITS.agentsPerFolder)
          .map((a) => a.slice(0, 64))
      : [];
    folders.push({ path: f.path.slice(0, ACCESS_LIMITS.path), agents });
  }
  return {
    folders,
    tools: {
      claude: t.claude === true,
      codex: t.codex === true,
      commands: t.commands === true,
      ...(t.browser === true ? { browser: true } : {}),
    },
  };
}

/** `hello.browser` (protocol 12), cut. */
export function parseBrowserInfo(v: Record<string, unknown>): RunnerBrowserInfo {
  const version = cut(v.version, 40);
  const chrome = cut(v.chrome, 120);
  const reason = cut(v.reason, BROWSER_LIMITS.message);
  return {
    available: v.available === true,
    ...(version !== undefined ? { version } : {}),
    ...(chrome !== undefined ? { chrome } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

const BROWSER_MODIFIERS_MAX = 15;
const coord = (v: unknown) => {
  const n = finite(v);
  return n !== undefined && Math.abs(n) <= 100_000 ? n : undefined;
};

/** One `browser.input` event, checked and cut; null when it isn't one (runner side). */
export function parseBrowserInputEvent(v: unknown): BrowserInputEvent | null {
  if (!isObject(v)) return null;
  const m = finite(v.modifiers);
  const modifiers =
    m !== undefined && Number.isInteger(m) && m >= 0 && m <= BROWSER_MODIFIERS_MAX ? { modifiers: m } : {};
  switch (v.kind) {
    case "mouse": {
      const type = (["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"] as const).find((t) => t === v.type);
      const x = coord(v.x);
      const y = coord(v.y);
      if (!type || x === undefined || y === undefined) return null;
      const button = (["left", "right", "middle", "none"] as const).find((b) => b === v.button);
      const clickCount = finite(v.clickCount);
      const deltaX = coord(v.deltaX);
      const deltaY = coord(v.deltaY);
      return {
        kind: "mouse",
        type,
        x,
        y,
        ...(button ? { button } : {}),
        ...(clickCount !== undefined ? { clickCount: Math.max(0, Math.min(3, Math.round(clickCount))) } : {}),
        ...(deltaX !== undefined ? { deltaX } : {}),
        ...(deltaY !== undefined ? { deltaY } : {}),
        ...modifiers,
      };
    }
    case "key": {
      const type = (["keyDown", "keyUp", "char"] as const).find((t) => t === v.type);
      if (!type || !isString(v.key) || !v.key || v.key.length > 32) return null;
      const code = cut(v.code, 32);
      const text = cut(v.text, 8);
      return {
        kind: "key",
        type,
        key: v.key,
        ...(code !== undefined ? { code } : {}),
        ...(text !== undefined ? { text } : {}),
        ...modifiers,
      };
    }
    case "touch": {
      const type = (["touchStart", "touchMove", "touchEnd", "touchCancel"] as const).find((t) => t === v.type);
      if (!type || !Array.isArray(v.touchPoints)) return null;
      const touchPoints: { x: number; y: number }[] = [];
      for (const p of v.touchPoints.slice(0, 10)) {
        const x = isObject(p) ? coord(p.x) : undefined;
        const y = isObject(p) ? coord(p.y) : undefined;
        if (x === undefined || y === undefined) return null;
        touchPoints.push({ x, y });
      }
      return { kind: "touch", type, touchPoints, ...modifiers };
    }
    case "text":
      return isString(v.text) && v.text.length <= BROWSER_LIMITS.inputText ? { kind: "text", text: v.text } : null;
    default:
      return null;
  }
}
