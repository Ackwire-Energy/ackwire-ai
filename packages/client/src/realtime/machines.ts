import type { QueryClient } from "@tanstack/react-query";
import { keys } from "../api/keys";
import type {
  AgentComputer,
  ComputerSetup,
  ComputerTarget,
  Machine,
  MachineAccess,
  MachinePause,
  Me,
  OrgStanding,
} from "../api/types";

const MACHINE_EVENTS = new Set([
  "machine.status",
  "machine.paired",
  "machine.updated",
  "machine.state",
  "machine.access",
  "machine.deleted",
  "machine.agents_moved",
]);
const isMachineEvent = (type: string) => MACHINE_EVENTS.has(type);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * A pause state from an event: the server's `{ until }` (paused) or `null` (not paused); `{ paused: false }`
 * is understood too. Undefined when the event says nothing about it.
 */
export function pauseOf(v: unknown): MachinePause | undefined {
  if (v === null) return { paused: false };
  if (!isObject(v)) return undefined;
  if (v.paused === false) return { paused: false };
  return { paused: true, until: typeof v.until === "string" ? v.until : null };
}

/** Access from an event (`{ folders, tools }`), checked; `null` when the machine stopped reporting it. */
export function accessOf(v: unknown): MachineAccess | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !Array.isArray(v.folders) || !isObject(v.tools)) return undefined;
  const t = v.tools;
  return {
    folders: v.folders.flatMap((f) =>
      isObject(f) && typeof f.path === "string" && f.path
        ? [{ path: f.path, agents: Array.isArray(f.agents) ? f.agents.filter((a) => typeof a === "string") : [] }]
        : [],
    ),
    tools: {
      claude: t.claude === true,
      codex: t.codex === true,
      commands: t.commands === true,
      ...(t.browser === true ? { browser: true } : {}),
    },
  };
}

/** Every cached agent computer view whose target is this machine gets `patch`. */
function patchTargets(
  qc: QueryClient,
  orgId: string,
  machineId: string,
  patch: Partial<{ name: string; online: boolean }>,
) {
  qc.setQueriesData<AgentComputer>({ queryKey: keys.computers(orgId) }, (old) =>
    old?.target?.kind === "machine" && old.target.machineId === machineId
      ? { ...old, target: { ...old.target, ...patch } }
      : old,
  );
}

/**
 * Org events about connected computers (ADR 0025): the machines list and
 * the agents' computer views follow without a refetch where they can.
 * Returns whether the event was one of these.
 */
export function applyMachineEvent(qc: QueryClient, orgId: string, event: { type: string }): boolean {
  if (!isMachineEvent(event.type)) return false;
  const e = event as {
    type: string;
    machineId?: unknown;
    online?: unknown;
    name?: unknown;
    paused?: unknown;
    access?: unknown;
    accounts?: unknown;
  };
  if (typeof e.machineId !== "string") return true;
  const machineId = e.machineId;
  const list = keys.machines(orgId);
  // Who waits for an offline computer changes when one comes back, goes away or its agents move.
  if (e.type === "machine.status" || e.type === "machine.deleted" || e.type === "machine.agents_moved") {
    void qc.invalidateQueries({ queryKey: keys.machineOutages(orgId) });
  }
  // Whether agents can use their browser (ADR 0040) and what can think for them follow the computer: its
  // switches (the app's Ferramentas: `machine.updated` with `access`), a reconnect, a move. No reload needed.
  // ADR 0041: an account added, removed or signed out on the computer (`machine.updated` with `accounts`).
  const accounts = e.type === "machine.updated" && e.accounts !== undefined;
  if ((e.type !== "machine.state" && e.type !== "machine.updated") || e.access !== undefined || accounts) {
    void qc.invalidateQueries({ queryKey: keys.browser(orgId) });
    void qc.invalidateQueries({ predicate: (q) => isAgentBrainKey(q.queryKey, orgId) });
    void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
    void qc.invalidateQueries({ queryKey: keys.planUsage(orgId) });
  }
  switch (e.type) {
    case "machine.status": {
      const online = e.online === true;
      const now = new Date().toISOString();
      qc.setQueryData<Machine[]>(list, (old) =>
        old?.map((m) => (m.id === machineId ? { ...m, online, lastSeenAt: online ? now : m.lastSeenAt } : m)),
      );
      patchTargets(qc, orgId, machineId, { online });
      // A machine we don't know yet (paired in another tab): fetch it.
      if (!qc.getQueryData<Machine[]>(list)?.some((m) => m.id === machineId)) {
        void qc.invalidateQueries({ queryKey: list });
      }
      break;
    }
    case "machine.paired":
      void qc.invalidateQueries({ queryKey: list });
      break;
    case "machine.updated":
    case "machine.state":
    case "machine.access": {
      // A rename, a pause on the machine, or what it allows now (ADR 0036): patch what came, refetch otherwise.
      const patch: Partial<Machine> = {};
      if (typeof e.name === "string") patch.name = e.name;
      const paused = pauseOf(e.paused);
      if (paused) patch.paused = paused;
      const access = accessOf(e.access);
      if (access !== undefined) patch.access = access;
      if (Object.keys(patch).length > 0) {
        qc.setQueryData<Machine[]>(list, (old) => old?.map((m) => (m.id === machineId ? { ...m, ...patch } : m)));
        if (patch.name) patchTargets(qc, orgId, machineId, { name: patch.name });
      }
      // Nothing to patch, or `access: true` (it changed, and who may see it differs per person): refetch.
      if (Object.keys(patch).length === 0 || e.access === true) void qc.invalidateQueries({ queryKey: list });
      break;
    }
    case "machine.agents_moved":
      void qc.invalidateQueries({ queryKey: list });
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      break;
    case "machine.deleted":
      qc.setQueryData<Machine[]>(list, (old) => old?.filter((m) => m.id !== machineId));
      // Its agents went back to the cloud (`agent.computer` events follow; refetch anyway).
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      // The server's own computer, stopped here, offers to come back.
      void qc.invalidateQueries({ queryKey: keys.hostComputer(orgId) });
      break;
  }
  return true;
}

/** `keys.agentBrain(orgId, *)`: "Quem pensa" of any agent of the org. */
const isAgentBrainKey = (key: readonly unknown[], orgId: string) =>
  key[0] === "org" && key[1] === orgId && key[2] === "agent" && key[4] === "brain";

/**
 * `agent.computer`: a full view (`computer`), or only `target` when someone
 * switched computers. A target-only event keeps the cached status and
 * refetches the rest (cost, disk) in the background.
 */
export function applyComputerEvent(qc: QueryClient, orgId: string, event: { type: string }) {
  const e = event as { agentId?: unknown; computer?: AgentComputer; target?: ComputerTarget };
  if (event.type !== "agent.computer" || typeof e.agentId !== "string") return;
  const key = keys.computer(orgId, e.agentId);
  if (e.computer && typeof e.computer.status === "string") {
    const computer = e.computer;
    qc.setQueryData<AgentComputer>(key, (old) => ({ ...computer, target: computer.target ?? e.target ?? old?.target }));
    return;
  }
  if (e.target && typeof e.target.kind === "string") {
    const target = e.target;
    qc.setQueryData<AgentComputer>(key, (old) => (old ? { ...old, target } : old));
    void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
  }
  void qc.invalidateQueries({ queryKey: key });
  // A new computer changes what can think and whether the browser is there.
  void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, e.agentId) });
  void qc.invalidateQueries({ queryKey: keys.agentBrowser(orgId, e.agentId) });
}

const SETUP_FIELDS = [
  "state",
  "step",
  "stage",
  "reason",
  "since",
  "requestedAt",
  "expectedReadyAt",
  "secondsLeft",
  "secondsWaited",
  "specs",
  "machineId",
] as const;

/**
 * The workspace's own computer, standing and limits (ADR 0056 §8, §10), live: `machine.provisioning` (the fields of
 * `GET …/computer-setup` but `mode`) replaces what the setup query holds, and the computer's first hello
 * (`ready`) refetches the computers; `org.standing` sets this workspace's standing in `GET /me`, so the banner
 * and the suspended screen follow without a reload, and asks for the setup again: a workspace on hold waits for no
 * computer, and one active again waits for one. `org.limits` (a new plan, ADR 0077) asks for the limits again, so a
 * full workspace's invitations open by themselves. Returns whether the event was one of these.
 */
export function applyWorkspaceEvent(qc: QueryClient, orgId: string, event: { type: string }): boolean {
  if (event.type === "machine.provisioning") {
    const e = event as Partial<Record<(typeof SETUP_FIELDS)[number] | "notifyByEmail", unknown>>;
    const next = Object.fromEntries(SETUP_FIELDS.map((k) => [k, e[k] ?? null])) as Omit<
      ComputerSetup,
      "mode" | "notifyByEmail"
    >;
    qc.setQueryData<ComputerSetup>(keys.computerSetup(orgId), (old) => ({
      mode: "external",
      ...next,
      // Whether the server sends email is the server's, not the step's: an event without it keeps what was known.
      notifyByEmail: typeof e.notifyByEmail === "boolean" ? e.notifyByEmail : (old?.notifyByEmail ?? false),
    }));
    if (next.state === "ready") {
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      // Every agent's screen is there now: an open computer dialog shows it at once.
      void qc.invalidateQueries({ queryKey: keys.agentDesktops(orgId) });
    }
    return true;
  }
  if (event.type === "org.standing") {
    const e = event as { orgId?: unknown; state?: unknown; reason?: unknown; cloud?: unknown };
    const state = e.state === "hold" || e.state === "suspended" ? e.state : "active";
    const standing: OrgStanding = {
      state,
      reason: typeof e.reason === "string" && e.reason ? e.reason : null,
      ...(e.cloud === true ? { cloud: true } : {}),
    };
    const target = typeof e.orgId === "string" ? e.orgId : orgId;
    qc.setQueryData<Me>(keys.me, (me) =>
      me ? { ...me, organizations: me.organizations.map((o) => (o.id === target ? { ...o, standing } : o)) } : me,
    );
    void qc.invalidateQueries({ queryKey: keys.computerSetup(target) });
    return true;
  }
  if (event.type === "org.limits") {
    void qc.invalidateQueries({ queryKey: keys.limits(orgId) });
    return true;
  }
  return false;
}
