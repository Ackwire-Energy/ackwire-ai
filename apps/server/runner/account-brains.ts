import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AgentScope,
  BrainTurnRequest,
  MachineRequest,
  ToolNotice,
  TurnContext,
  WireBrainEvent,
} from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_SIGNED_OUT, type AccountManager } from "./accounts";
import { ACCOUNT_STORES, type AccountUsers, type AgentUser, accountLauncher } from "./agent-users";
import { BrainManager, type DelegatedFrame, type DelegatedTurn } from "./brain";
import type { ClaudeSharedLogin } from "./config";
import type { DelegatedBridge } from "./delegated-tools";
import { RunnerError } from "./errors";
import type { RequestScope } from "./handlers";
import { accountOf } from "./supervisor";

/**
 * Root's side of a Claude sign-in several agents share (`AccountManager.isCliShared`). Its CLIs are the only processes
 * with that sign-in's store, so they run as its user, started and fed by root: an agent's own worker runs as a uid the
 * agent's code can ptrace, and whoever holds a CLI's stdin can make it add a server that reads the store. The rest of
 * the turn is that worker's: where it runs, what its folder says, and every tool (`delegated-tools.ts`).
 *
 * Not yet here: tasks and routes. Nothing runs them on such a sign-in (`refusesHere`).
 */

/** How often a refresh's lock is looked for, and how long a spawn waits for it to go (a stale one must not stop turns). */
const REFRESH_POLL_MS = 200;
const REFRESH_WAIT_MS = 30_000;

export const SHARED_LOGIN_OFF =
  "This computer can't run this Claude sign-in right now. Sign in with a setup token in AI accounts, or try again later.";
const NOT_YET = "This Claude sign-in can't run background tasks or pick who answers yet.";

/** What it needs of the agents' workers (`Supervisor`). */
export interface AgentWorkers {
  /** The agent's OS user with its network now, once its worker is up. */
  agentReady(agent: AgentScope, signal: AbortSignal): Promise<AgentUser>;
  turnContext(agent: AgentScope, ask: { cwd?: string; text?: boolean }, signal: AbortSignal): Promise<TurnContext>;
  bridge(bridge: DelegatedBridge): Promise<void>;
  tell(agentId: string, frame: { type: "turn.cancel" | "turn.detach"; session: string }): void;
  /** Until the returned call, the agent's network waits for this turn; `dropped` hears its worker's session ended. */
  hold(agentId: string, dropped: (err: RunnerError) => void): () => void;
  reclaimBrains(spare?: string): Promise<boolean>;
}

export interface AccountBrainsOptions {
  /** `<runner home>/account-brains`: the system text each session began with. */
  root: string;
  accounts: Pick<AccountManager, "isCliShared" | "cliSharedState" | "sharedCommand" | "noteRateLimit">;
  users: Pick<AccountUsers, "ensure" | "room" | "bridge">;
  workers: AgentWorkers;
  /** The folders the agent may use besides its own: root's own word, what a turn's cwd is checked against. */
  grants: (agentId: string) => Promise<string[]>;
  /** The runner's own command: the relay the CLI starts. */
  relay: string[];
  shared: () => ClaudeSharedLogin | undefined;
  idleMs?: number;
  maxProcesses?: number;
  log?: (line: string) => void;
  /** Tests. */
  stores?: string;
  launcher?: typeof accountLauncher;
  deltaMs?: number;
}

export class AccountBrains {
  readonly brains: BrainManager;

  constructor(private readonly o: AccountBrainsOptions) {
    this.brains = new BrainManager({
      root: o.root,
      accounts: { accountDir: () => null, noteRateLimit: (key, info) => o.accounts.noteRateLimit(key, info) },
      ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
      ...(o.maxProcesses !== undefined ? { maxProcesses: o.maxProcesses } : {}),
      ...(o.deltaMs !== undefined ? { deltaMs: o.deltaMs } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  }

  /** A request for such a sign-in that must run here. */
  takes(req: MachineRequest): req is Extract<MachineRequest, { op: "brain.turn" }> {
    return req.op === "brain.turn" && this.onSharedLogin(req);
  }

  /** What no worker can do on such a sign-in and nothing here does yet. */
  refusesHere(req: MachineRequest) {
    if ((req.op === "brain.route" || req.op === "task.start") && this.onSharedLogin(req)) {
      throw new RunnerError("unsupported", NOT_YET);
    }
  }

  private onSharedLogin(req: MachineRequest) {
    const signIn = accountOf(req);
    return signIn?.kind === "claude_code" && this.o.accounts.isCliShared("claude_code", signIn.account);
  }

  toolNotice(agentId: string, notice: ToolNotice) {
    this.brains.toolNotice(agentId, notice);
  }

  /** The computer is short of memory: an idle CLI closes, here or a worker's, the waiting turn's own (`spare`) last. */
  async reclaim(spare: string) {
    const idle = this.brains.idleCandidate(spare);
    if (idle && !idle.spare && (await this.brains.reclaimIdle(spare))) return true;
    return (await this.o.workers.reclaimBrains(spare)) || this.brains.reclaimIdle(spare);
  }

  /** One turn. A worker that goes away under it fails it as `dropped`, so the server resumes it as any agent's turn. */
  async turn(
    req: Extract<MachineRequest, { op: "brain.turn" }>,
    agent: AgentScope,
    scope: Pick<RequestScope, "signal">,
    emit: (e: WireBrainEvent) => void,
  ): Promise<WireBrainEvent> {
    const account = String(req.account);
    const state = this.o.accounts.cliSharedState(account);
    if (state !== "ready") {
      const final: WireBrainEvent =
        state === "off"
          ? { type: "error", code: "unsupported", message: SHARED_LOGIN_OFF, retryable: true }
          : { type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true };
      emit(final);
      return final;
    }
    const user = await this.o.workers.agentReady(agent, scope.signal);
    const stop = new AbortController();
    const cancel = () => stop.abort();
    scope.signal.addEventListener("abort", cancel, { once: true });
    if (scope.signal.aborted) cancel();
    let dropped: RunnerError | undefined;
    const release = this.o.workers.hold(agent.id, (err) => {
      dropped = err;
      stop.abort();
    });
    try {
      const final = await this.brains.turn(req as BrainTurnRequest, {
        agent,
        folder: "",
        signal: stop.signal,
        emit: (e) => {
          if (!dropped) emit(e);
        },
        delegated: await this.delegated(account, agent, user, stop.signal),
      });
      if (dropped) throw dropped;
      return final;
    } finally {
      release();
      scope.signal.removeEventListener("abort", cancel);
    }
  }

  private async delegated(
    account: string,
    agent: AgentScope,
    user: AgentUser,
    signal: AbortSignal,
  ): Promise<DelegatedTurn> {
    const { users, workers, accounts } = this.o;
    const signIn = users.ensure(account);
    users.room(signIn, user.uid);
    const socketPath = users.bridge(signIn, user);
    const store = path.join(this.o.stores ?? ACCOUNT_STORES, account);
    const configDir = path.join(store, "config");
    const grants = await this.o.grants(agent.id);
    return {
      configDir,
      room: path.join(store, "run", String(user.uid)),
      relay: { socketPath, command: this.o.relay },
      where: (cwd) => workers.turnContext(agent, cwd ? { cwd } : {}, signal),
      text: async (cwd) => (await workers.turnContext(agent, { cwd, text: true }, signal)).text ?? "",
      launch: async (cwd) => {
        await this.refreshOver(configDir, signal);
        const l = (this.o.launcher ?? accountLauncher)(signIn, user, cwd, grants);
        return { command: accounts.sharedCommand(l.prefix), env: l.env, cwd: l.home };
      },
      bridge: (frame: DelegatedFrame) => workers.bridge({ ...frame, agent, socketPath }),
      cancel: (session) => workers.tell(agent.id, { type: "turn.cancel", session }),
      detach: (session) => workers.tell(agent.id, { type: "turn.detach", session }),
    };
  }

  /**
   * Refresh mode B, for a CLI version whose refreshes clash unless no new CLI starts during one. Only the lock's name
   * is looked at, never a file's content. A lock older than the wait is stale: turns go on.
   */
  private async refreshOver(configDir: string, signal: AbortSignal) {
    const shared = this.o.shared();
    if (shared?.refresh !== "B" || !shared.refreshLock) return;
    const lock = path.join(configDir, shared.refreshLock);
    const until = Date.now() + REFRESH_WAIT_MS;
    while (existsSync(lock) && Date.now() < until && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
    }
  }
}
