/**
 * Test fake — the agents' PCs (sandbox). Mirrors `GET/PUT …/sandbox-settings`
 * (apps/server/src/routes/app/sandboxes.ts) and the expected
 * `GET …/agents/{id}/computer`, `POST …/computer/stop|start`, `DELETE …/computer`.
 */
import type { ApiClient } from "@/api/client";
import { ApiError } from "@/api/http";
import type { AgentComputer, ComputerTarget, SandboxSettings } from "@/api/types";
import { clone, type MockContext } from "./context";
import type { FakeMachines } from "./machines";

export function createFakeSandbox(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
  machines?: FakeMachines,
): ApiClient["sandbox"] {
  /** `PUT …/computer/target`: agent → machine id (absent = the cloud). */
  const targets = new Map<string, string>();
  const targetOf = (agentId: string): ComputerTarget => {
    const id = targets.get(agentId);
    const m = id ? machines?.peek(id) : undefined;
    return m ? { kind: "machine", machineId: m.id, name: m.name, online: m.online } : { kind: "cloud" };
  };
  /** Like the server: start/stop on a machine is `400 machine.no_lifecycle`. */
  const refuseOnMachine = (agentId: string) => {
    if (targetOf(agentId).kind === "machine") {
      throw new ApiError(400, "machine.no_lifecycle", "This agent uses a connected computer");
    }
  };
  let settings: SandboxSettings = {
    available: true,
    enabled: true,
    allowDomains: [],
    network: "blocked",
    execTimeoutSeconds: 120,
    maxTimeoutSeconds: 900,
    dailyMinutes: 120,
    requireApproval: false,
  };
  const pcs = new Map<string, AgentComputer>();
  const pc = async (orgId: string, agentId: string) => {
    let c = pcs.get(agentId);
    if (!c) {
      const agents = await ctx.lookup.agents(orgId);
      // The first agent already has a PC; the others don't yet.
      c =
        agents[0]?.id === agentId
          ? {
              status: "running",
              diskUsedGib: 1.2,
              costMonthUsd: 0.84,
              createdAt: ctx.now().toISOString(),
              lastUsedAt: ctx.now().toISOString(),
              network: "allowlist",
            }
          : { status: "none", diskUsedGib: 0, costMonthUsd: 0, createdAt: null, lastUsedAt: null };
      pcs.set(agentId, c);
    }
    return c;
  };
  return {
    settings: async () => clone(settings),
    saveSettings: async (orgId, input) => {
      log("sandbox.saveSettings", orgId, input);
      settings = { ...settings, ...input };
      // Like the server: running PCs get a new network rule in place.
      return clone({ ...settings, networkApply: "live" as const });
    },
    computer: async (orgId, agentId) => clone({ ...(await pc(orgId, agentId)), target: targetOf(agentId) }),
    start: async (orgId, agentId) => {
      log("sandbox.start", orgId, agentId);
      refuseOnMachine(agentId);
      const c = await pc(orgId, agentId);
      c.status = "running";
      c.lastUsedAt = ctx.now().toISOString();
      if (!c.createdAt) c.createdAt = ctx.now().toISOString();
      return clone(c);
    },
    stop: async (orgId, agentId) => {
      log("sandbox.stop", orgId, agentId);
      refuseOnMachine(agentId);
      const c = await pc(orgId, agentId);
      c.status = "stopped";
      return clone(c);
    },
    remove: async (orgId, agentId) => {
      log("sandbox.remove", orgId, agentId);
      pcs.set(agentId, { status: "none", diskUsedGib: 0, costMonthUsd: 0, createdAt: null, lastUsedAt: null });
    },
    setTarget: async (orgId, agentId, machineId) => {
      log("sandbox.setTarget", orgId, agentId, machineId);
      const before = targets.get(agentId);
      if (machineId) targets.set(agentId, machineId);
      else targets.delete(agentId);
      if (machines) {
        const agents = await ctx.lookup.agents(orgId);
        for (const id of new Set([before, machineId].filter((x): x is string => Boolean(x)))) {
          machines.setAgents(
            id,
            agents.filter((a) => targets.get(a.id) === id).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
          );
        }
      }
      return targetOf(agentId);
    },
  };
}
