/**
 * Test fake — the agents' PCs (sandbox). Mirrors `GET/PUT …/sandbox-settings`
 * (apps/server/src/routes/app/sandboxes.ts) and the expected
 * `GET …/agents/{id}/computer`, `POST …/computer/stop|start`, `DELETE …/computer`.
 */
import type { ApiClient } from "@/api/client";
import type { AgentComputer, SandboxSettings } from "@/api/types";
import { clone, type MockContext } from "./context";

export function createFakeSandbox(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["sandbox"] {
  let settings: SandboxSettings = {
    available: true,
    enabled: true,
    allowDomains: [],
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
      return clone(settings);
    },
    computer: async (orgId, agentId) => clone(await pc(orgId, agentId)),
    start: async (orgId, agentId) => {
      log("sandbox.start", orgId, agentId);
      const c = await pc(orgId, agentId);
      c.status = "running";
      c.lastUsedAt = ctx.now().toISOString();
      if (!c.createdAt) c.createdAt = ctx.now().toISOString();
      return clone(c);
    },
    stop: async (orgId, agentId) => {
      log("sandbox.stop", orgId, agentId);
      const c = await pc(orgId, agentId);
      c.status = "stopped";
      return clone(c);
    },
    remove: async (orgId, agentId) => {
      log("sandbox.remove", orgId, agentId);
      pcs.set(agentId, { status: "none", diskUsedGib: 0, costMonthUsd: 0, createdAt: null, lastUsedAt: null });
    },
  };
}
