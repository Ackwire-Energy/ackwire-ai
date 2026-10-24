import {
  type AgentScope,
  GIT_PROTOCOL,
  type GitSyncRepo,
  type GitSyncRequest,
  gitCheckoutDir,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { activeConnections } from "../connectors/connections";
import type { MachineCaller, MachineCallOptions, MachineStatus } from "../machine-hub";
import { MachineOfflineError, MachinePausedError } from "../machines";
import { missionOfRun } from "../mission-context";
import { grantedScopeKeys } from "../tools/scopes";
import { agentCommitEmail, GIT_TOKEN_TTL_SECONDS, gitProxyBase, issueGitToken, machineGitGen } from "./credential";
import { gitAccess } from "./proxy";
import { agentRepositoryList, type CodeCheckout, codePrompt, repoInList } from "./repos";

/**
 * Git on a connected machine through our proxy (ADR 0024 addendum):
 * the server issues the proxy credential for that machine and agent, and the
 * runner clones or updates the agent's checkouts in its own folder
 * (`repos/<owner>/<name>`) with `git.sync` (protocol 11). Only our
 * credential reaches the machine (revocable, scoped to the agent's granted
 * repositories, pushes only to `agentes/<handle>/…`); GitHub's token stays here.
 */
export interface MachineGitDeps {
  db: Database;
  hub: MachineCaller;
  /** Our public URL and AGENTES_SECRET (the proxy credential is an HMAC of it). */
  git: { publicUrl: string; secret: string };
  now?: () => Date;
}

/** A clone may take this long (partial clone, but a big checkout on a slow link). */
export const MACHINE_CLONE_SECONDS = 1800;
/** Before a chat turn: every fetch of the agent's checkouts together, at most this long. */
export const PRE_TURN_SYNC_SECONDS = 20;

/** Why git can't run on the machine now (said to the agent), or null. */
export function machineGitUnavailable(status: MachineStatus | null, orgId: string): Error | null {
  if (!status || status.orgId !== orgId) {
    return new Error("Your connected computer was removed; ask an admin or your owner to choose another one.");
  }
  if (!status.online) return new MachineOfflineError(status.name);
  if (status.paused) return new MachinePausedError(status.name, status.paused.until, status.paused.timezone);
  if (status.protocol < GIT_PROTOCOL) {
    return new Error(
      `The agentes app (runner) on the computer ${status.name} is too old to clone repositories. Tell the person: its owner should update it (the app updates itself; or agentes-runner update).`,
    );
  }
  return null;
}

/**
 * The `proxy` and `author` of a `git.sync` for this agent on this machine:
 * a fresh proxy credential (6 h) bound to the machine and the agent. Null
 * when the org has no GitHub connection or the agent has no git access.
 */
export async function machineGitSetup(
  deps: MachineGitDeps,
  orgId: string,
  agentId: string,
  machineId: string,
): Promise<(Pick<GitSyncRequest, "proxy" | "author"> & { agent: AgentScope }) | null> {
  const connection = (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  if (!connection) return null;
  const keys = await grantedScopeKeys(deps.db, orgId, agentId);
  if (!gitAccess(keys, connection.id).read) return null;
  const agent = await getAgentCached(deps.db, orgId, agentId);
  if (!agent || agent.machineId !== machineId) return null;
  const [machine] = await deps.db
    .select({ tokenHash: schema.machines.tokenHash })
    .from(schema.machines)
    .where(and(eq(schema.machines.id, machineId), eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  if (!machine?.tokenHash) return null;
  const now = deps.now?.() ?? new Date();
  const token = issueGitToken(deps.git.secret, {
    orgId,
    agentId,
    sandboxId: machineId,
    gen: machineGitGen(machine.tokenHash),
    exp: Math.floor(now.getTime() / 1000) + GIT_TOKEN_TTL_SECONDS,
    kind: "machine",
  });
  return {
    proxy: { base: gitProxyBase(deps.git.publicUrl, orgId, connection.id), token },
    author: { name: `${agent.name} (agentes)`, email: agentCommitEmail(deps.git.publicUrl, agent.handle) },
    agent: { id: agent.id, handle: agent.handle, name: agent.name },
  };
}

/** `git_clone` on a connected machine: clones (or, when it is there, updates) one repository in the agent's folder. */
export async function cloneOnMachine(
  deps: MachineGitDeps,
  target: { orgId: string; agentId: string; machineId: string },
  input: { repo: string; dir?: string; signal?: AbortSignal; onOutput?: MachineCallOptions["onOutput"] },
): Promise<GitSyncRepo> {
  const unavailable = machineGitUnavailable(await deps.hub.status(target.machineId), target.orgId);
  if (unavailable) throw unavailable;
  const setup = await machineGitSetup(deps, target.orgId, target.agentId, target.machineId);
  if (!setup)
    throw new Error("You have no git access to GitHub here (scope github:git.read), or GitHub isn't connected.");
  const { agent, ...rest } = setup;
  const reply = await deps.hub.call(
    target.machineId,
    {
      op: "git.sync",
      agent,
      ...rest,
      repos: [{ repo: input.repo, dir: input.dir || gitCheckoutDir(input.repo), clone: true }],
      timeoutSeconds: MACHINE_CLONE_SECONDS,
      stream: Boolean(input.onOutput),
    },
    { ...(input.signal ? { signal: input.signal } : {}), ...(input.onOutput ? { onOutput: input.onOutput } : {}) },
  );
  const result = reply.repos[0];
  if (!result) throw new Error("The computer answered without the repository.");
  return result;
}

/** The repository the conversation names (newest text first), among `repos` (`owner/name`); null when none. */
export function namedRepo(repos: readonly string[], texts: readonly string[]): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const text of texts) {
    let best: { repo: string; at: number } | null = null;
    for (const repo of repos) {
      const name = repo.split("/")[1] ?? "";
      const patterns = [new RegExp(`(^|[^A-Za-z0-9_.-])${esc(repo)}(?![A-Za-z0-9_-])`, "i")];
      if (name.length >= 3) patterns.push(new RegExp(`(^|[^A-Za-z0-9_./-])${esc(name)}(?![A-Za-z0-9_/-])`, "i"));
      for (const p of patterns) {
        const m = p.exec(text);
        if (m && (!best || m.index < best.at)) best = { repo, at: m.index };
      }
    }
    if (best) return best.repo;
  }
  return null;
}

/** What a chat turn needs from `prepareAgentCode`. */
export interface CodeTurn {
  orgId: string;
  agentId: string;
  threadRootId: string | null;
  trigger: string;
  messages: ReadonlyArray<{ content: string }>;
  session?: { machineId: string; cwd: string } | undefined;
}

/**
 * Before a chat turn of a computer brain (Claude Code, Codex) on a connected
 * machine: updates the agent's checkouts (fetch + fast-forward of the default
 * branch, bounded, never failing the turn), picks where the turn starts (the
 * repository the conversation names, else the agent's first repository, else
 * its first checkout) and writes the "# Your code" block. Null when there is
 * nothing to do: a mission turn (it has its own folder), an older runner, no
 * GitHub or no git access, or nothing granted or checked out.
 */
export async function prepareAgentCode(
  deps: MachineGitDeps,
  turn: CodeTurn,
  options: { signal?: AbortSignal } = {},
): Promise<{ cwd: string; prompt: string } | null> {
  // A chat turn starts in the agent's folder (""); a mission's turn has its own folder.
  const session = turn.session?.cwd === "" ? turn.session : null;
  if (!session) return null;
  try {
    // A mission's thread works in the mission's own folder.
    if (turn.threadRootId && (await missionOfRun({ db: deps.db, ...turn, threadRootId: turn.threadRootId }))) {
      return null;
    }
    if (machineGitUnavailable(await deps.hub.status(session.machineId), turn.orgId)) return null;
    const setup = await machineGitSetup(deps, turn.orgId, turn.agentId, session.machineId);
    if (!setup) return null;
    const list = await agentRepositoryList(deps.db, turn.orgId, turn.agentId);
    const explicit = list.filter((r) => !r.endsWith("/*"));
    const { agent, ...rest } = setup;
    const reply = await deps.hub.call(
      session.machineId,
      {
        op: "git.sync",
        agent,
        ...rest,
        repos: explicit.map((repo) => ({ repo, dir: gitCheckoutDir(repo), clone: false })),
        existing: true,
        timeoutSeconds: PRE_TURN_SYNC_SECONDS,
      },
      { timeoutMs: (PRE_TURN_SYNC_SECONDS + 15) * 1000, ...(options.signal ? { signal: options.signal } : {}) },
    );
    const present = reply.repos.filter((r) => {
      const [owner = "", name = ""] = r.repo.split("/");
      const there = r.status === "cloned" || r.status === "updated" || (r.status === "failed" && Boolean(r.head));
      // Only what the agent may still use (a repository removed from its list stays on disk, unmentioned).
      return there && repoInList(list, owner, name);
    });
    const lower = new Set(present.map((r) => r.repo.toLowerCase()));
    const notCloned = explicit.filter((r) => !lower.has(r.toLowerCase()));
    if (present.length === 0 && notCloned.length === 0) return null;
    const texts = [
      turn.trigger,
      ...turn.messages
        .slice(-8)
        .map((m) => m.content)
        .reverse(),
    ];
    const named = namedRepo(
      present.map((r) => r.repo),
      texts,
    );
    const primary = explicit.find((r) => lower.has(r.toLowerCase()));
    const start =
      present.find((r) => r.repo === named) ??
      present.find((r) => r.repo.toLowerCase() === primary?.toLowerCase()) ??
      present[0];
    const checkouts: CodeCheckout[] = present.map((r) => ({
      repo: r.repo,
      path: r.path ?? r.dir,
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
      ...(r.status === "failed" ? { stale: r.message || "the update failed" } : {}),
    }));
    const prompt = codePrompt({
      handle: agent.handle,
      checkouts,
      notCloned,
      cwd: start ? (start.path ?? start.dir) : null,
    });
    return { cwd: start?.dir ?? "", prompt };
  } catch {
    // Offline, slow, refused: the turn goes on in the agent's folder, as before.
    return null;
  }
}
