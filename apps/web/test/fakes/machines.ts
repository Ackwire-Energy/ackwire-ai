/**
 * Test fake — connected computers (ADR 0025). Mirrors
 * apps/server/src/routes/machines.ts:
 * - `GET    …/machines` → `{ machines: Machine[] }`
 * - `POST   …/machines/pairings` `{ name }` → `{ code, expiresAt, installCommand }`
 * - `PATCH  …/machines/{id}` `{ name }`, `DELETE …/machines/{id}`
 * Tests add machines with `pair()` (what the runner's `pair` does on the server).
 * No machines by default.
 */
import type { ApiClient, Machine } from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError } from "./context";

export interface FakeMachines {
  client: ApiClient["machines"];
  /** The runner paired (`POST /api/machines/pair`): a new machine, online. */
  pair(input: Partial<Machine> & { name: string }): Machine;
  /** The stored machine (for the sandbox fake's `target`). */
  peek(id: string): Machine | undefined;
  /** Agents moved onto or off a machine. */
  setAgents(id: string, agents: Machine["agents"]): void;
  all(): Machine[];
}

let seq = 0;

export function createFakeMachines(ctx: MockContext, log: (method: string, ...args: unknown[]) => void): FakeMachines {
  const machines: Machine[] = [];
  const find = (id: string) => {
    const m = machines.find((x) => x.id === id);
    if (!m) throw new MockNotFoundError("Computador não encontrado.");
    return m;
  };
  return {
    client: {
      list: async () => clone(machines),
      createPairing: async (orgId, input) => {
        log("machines.createPairing", orgId, input);
        const code = "K7QM-4XTB";
        return {
          code,
          expiresAt: new Date(ctx.now().getTime() + 10 * 60_000).toISOString(),
          installCommand: `curl -fsSL http://localhost:3000/api/machines/install.sh | sh -s -- --code ${code}`,
        };
      },
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
    },
    pair: (input) => {
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
    },
    peek: (id) => machines.find((m) => m.id === id),
    setAgents: (id, agents) => {
      const m = machines.find((x) => x.id === id);
      if (m) m.agents = agents;
    },
    all: () => clone(machines),
  };
}
