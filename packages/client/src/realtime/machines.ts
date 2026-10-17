import type { QueryClient } from "@tanstack/react-query";
import { keys } from "../api/keys";
import type { AgentComputer, ComputerTarget, Machine } from "../api/types";

const isMachineEvent = (type: string) =>
  type === "machine.status" || type === "machine.paired" || type === "machine.updated" || type === "machine.deleted";

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
  const e = event as { type: string; machineId?: unknown; online?: unknown; name?: unknown };
  if (typeof e.machineId !== "string") return true;
  const machineId = e.machineId;
  const list = keys.machines(orgId);
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
      if (typeof e.name === "string") {
        const name = e.name;
        qc.setQueryData<Machine[]>(list, (old) => old?.map((m) => (m.id === machineId ? { ...m, name } : m)));
        patchTargets(qc, orgId, machineId, { name });
      } else void qc.invalidateQueries({ queryKey: list });
      break;
    case "machine.deleted":
      qc.setQueryData<Machine[]>(list, (old) => old?.filter((m) => m.id !== machineId));
      // Its agents went back to the cloud (`agent.computer` events follow; refetch anyway).
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      break;
  }
  return true;
}

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
}
