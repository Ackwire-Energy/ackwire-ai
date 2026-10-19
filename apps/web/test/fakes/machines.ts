/**
 * Test fake — connected computers (ADR 0025, ADR 0036). Mirrors
 * apps/server/src/routes/machines.ts:
 * - `GET    …/machines` → `{ machines: Machine[] }`
 * - `PATCH  …/machines/{id}` `{ name }`, `DELETE …/machines/{id}`
 * - `GET    /api/app/machines/device/{userCode}` → the computer that made the code (404 once gone)
 * - `POST   …/organizations/{orgId}/machines/device/{userCode}/confirm` `{ name? }` → 201, the machine
 *   (the same one when the code's `reconnect` names a machine of that organization)
 * - `POST   /api/app/machines/device/{userCode}/deny` → 204
 * - `POST   …/machines/{id}/access/reduce` `{ removeFolder?, disableTool? }` → the new access
 * - `GET    /api/desktop/latest?target=&arch=` → the release, or 404 (`null`)
 * - `GET    …/machines/outages` → `{ outages, targets }` (offline computers agents wait for)
 * - `POST   …/machines/{id}/move-agents` `{ agentIds, target }` → `{ moved, skipped, resumed, stillWaiting }`
 * Tests add machines with `pair()`, codes with `addDevice()`, a release with `setRelease()`, outages with
 * `setOutages()` and the move's answer with `setMoveResult()`. No machines, codes, release or outages by default.
 */
import type {
  ApiClient,
  DesktopRelease,
  DeviceRequest,
  Machine,
  MachineOutages,
  MoveAgentsResult,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError } from "./context";

export interface FakeMachines {
  client: ApiClient["machines"];
  /** The computer connected (the device flow finished on the server): a new machine, online. */
  pair(input: Partial<Machine> & { name: string }): Machine;
  /** The stored machine (for the sandbox fake's `target`). */
  peek(id: string): Machine | undefined;
  /** Agents moved onto or off a machine. */
  setAgents(id: string, agents: Machine["agents"]): void;
  /** What the machine reports (pause, access) changes. */
  patch(id: string, patch: Partial<Machine>): void;
  all(): Machine[];
  /** A computer asked for a code (`POST /api/machines/device`). */
  addDevice(userCode: string, input?: Partial<DeviceRequest>): DeviceRequest;
  /** The newest desktop build; `null` = none (404). */
  setRelease(release: DesktopRelease | null): void;
  /** Offline computers and where their agents could go. */
  setOutages(outages: MachineOutages): void;
  /** What `moveAgents` answers (default: every agent moved, nothing else). */
  setMoveResult(result: MoveAgentsResult | null): void;
}

let seq = 0;

const gone = () => new ApiError(404, "machine.device_not_found", "This code expired or was already used");

export function createFakeMachines(ctx: MockContext, log: (method: string, ...args: unknown[]) => void): FakeMachines {
  const machines: Machine[] = [];
  const devices = new Map<string, DeviceRequest>();
  let release: DesktopRelease | null = null;
  let outages: MachineOutages = { outages: [], targets: [] };
  let moveResult: MoveAgentsResult | null = null;
  const find = (id: string) => {
    const m = machines.find((x) => x.id === id);
    if (!m) throw new MockNotFoundError("Computador não encontrado.");
    return m;
  };
  const device = (userCode: string) => {
    const d = devices.get(userCode);
    if (!d || Date.parse(d.expiresAt) <= ctx.now().getTime()) throw gone();
    return d;
  };
  const pair: FakeMachines["pair"] = (input) => {
    const m: Machine = {
      id: `00000000-0000-4000-8000-0000000009${String(++seq).padStart(2, "0")}`,
      online: true,
      lastSeenAt: ctx.now().toISOString(),
      hostname: "office-1",
      os: "linux",
      arch: "x64",
      runnerVersion: "0.1.0",
      execAllowed: true,
      pairedBy: { id: "u-walter", name: "Walter" },
      agents: [],
      workspace: "/home/runner/agentes",
      canManage: true,
      createdAt: ctx.now().toISOString(),
      ...input,
    };
    machines.push(m);
    return clone(m);
  };
  return {
    client: {
      list: async () => clone(machines),
      rename: async (orgId, machineId, name) => {
        log("machines.rename", orgId, machineId, name);
        const m = find(machineId);
        m.name = name;
        return { id: m.id, name };
      },
      remove: async (orgId, machineId) => {
        log("machines.remove", orgId, machineId);
        find(machineId);
        machines.splice(
          machines.findIndex((m) => m.id === machineId),
          1,
        );
      },
      device: async (userCode) => {
        log("machines.device", userCode);
        return clone(device(userCode));
      },
      confirmDevice: async (orgId, userCode, input) => {
        log("machines.confirmDevice", orgId, userCode, input);
        const d = device(userCode);
        devices.delete(userCode);
        // A reconnect in the same organization brings back the same machine (name kept).
        const back = d.reconnect?.orgId === orgId ? machines.find((m) => m.id === d.reconnect?.machineId) : undefined;
        if (back) {
          Object.assign(back, { online: true, hostname: d.hostname, runnerVersion: d.version });
          return clone(back);
        }
        // A new computer gets no agents until someone points one at it.
        return pair({
          name: input.name ?? d.name,
          os: d.os,
          arch: d.arch,
          hostname: d.hostname,
          runnerVersion: d.version,
        });
      },
      denyDevice: async (userCode) => {
        log("machines.denyDevice", userCode);
        device(userCode);
        devices.delete(userCode);
      },
      reduceAccess: async (orgId, machineId, input) => {
        log("machines.reduceAccess", orgId, machineId, input);
        const m = find(machineId);
        const access = m.access ?? { folders: [], tools: { claude: false, codex: false, commands: false } };
        const remove = input.removeFolder;
        const folders = remove
          ? access.folders.flatMap((f) => {
              if (f.path !== remove.path) return [f];
              const agentId = remove.agentId;
              return agentId ? [{ ...f, agents: f.agents.filter((a) => a !== agentId) }] : [];
            })
          : access.folders;
        const tools = input.disableTool ? { ...access.tools, [input.disableTool]: false } : access.tools;
        m.access = { folders, tools };
        return clone(m.access);
      },
      desktopLatest: async (target, arch) => {
        log("machines.desktopLatest", target, arch);
        return release ? clone(release) : null;
      },
      // Read on every workspace page (the notice): not logged, so tests' call lists stay as they were.
      outages: async () => clone(outages),
      moveAgents: async (orgId, machineId, input) => {
        log("machines.moveAgents", orgId, machineId, input);
        return clone(moveResult ?? { moved: input.agentIds, skipped: [], resumed: 0, stillWaiting: 0 });
      },
    },
    pair,
    peek: (id) => machines.find((m) => m.id === id),
    setAgents: (id, agents) => {
      const m = machines.find((x) => x.id === id);
      if (m) m.agents = agents;
    },
    patch: (id, patch) => {
      const m = machines.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
    },
    all: () => clone(machines),
    setOutages: (next) => {
      outages = clone(next);
    },
    setMoveResult: (next) => {
      moveResult = next;
    },
    addDevice: (userCode, input = {}) => {
      const now = ctx.now();
      const d: DeviceRequest = {
        name: "MacBook do Walter",
        os: "darwin",
        arch: "arm64",
        hostname: "walter-mbp",
        version: "0.2.0",
        approxLocation: "Curitiba, PR, Brasil",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        ...input,
      };
      devices.set(userCode, d);
      return clone(d);
    },
    setRelease: (r) => {
      release = r;
    },
  };
}
