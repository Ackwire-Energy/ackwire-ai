import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./context";
import { ApiError } from "./http";
import { keys } from "./keys";
import type { MachineTask, Mission, MissionControl, MissionCreateInput, MissionListStatus } from "./types";

/**
 * React Query hooks for missions (ADR 0029). `mission.updated` and
 * `machine.task` keep them live (realtime/context.tsx); every write puts the
 * fresh mission in the cache and refreshes the lists and the thread.
 */

type QC = ReturnType<typeof useQueryClient>;

/** A mission view came back: the one, its thread's, and every list. */
export function cacheMission(qc: QC, orgId: string, mission: Mission) {
  qc.setQueryData(keys.mission(orgId, mission.id), mission);
  qc.setQueryData(keys.threadMission(orgId, mission.threadId), mission);
  void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "list"] });
  void qc.invalidateQueries({ queryKey: keys.threads(orgId), predicate: (q) => q.queryKey[3] !== "one" });
}

/** The Missões tab (and the sidebar's count): open missions by default. */
export function useMissionList(orgId: string, status: MissionListStatus = "open", enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.missionList(orgId, status),
    queryFn: () => api.missions.list(orgId, status),
    enabled,
    staleTime: 15_000,
  });
}

export function useMission(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.mission(orgId, missionId ?? ""),
    queryFn: () => api.missions.get(orgId, missionId ?? ""),
    enabled: Boolean(missionId),
    staleTime: 15_000,
  });
}

/** The mission of a thread: null when it has none (`mission.not_found`), no error. */
export function useThreadMission(orgId: string, threadId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.threadMission(orgId, threadId ?? ""),
    queryFn: async (): Promise<Mission | null> => {
      try {
        return await api.missions.ofThread(orgId, threadId ?? "");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(threadId) && enabled,
    staleTime: 15_000,
  });
}

/** The thread's background tasks (one row per session), newest first. */
export function useThreadTasks(orgId: string, threadId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.threadTasks(orgId, threadId ?? ""),
    queryFn: () => api.missions.threadTasks(orgId, threadId ?? ""),
    enabled: Boolean(threadId) && enabled,
    staleTime: 30_000,
  });
}

/** A `machine.task` event: replace that task in the thread's list. */
export function cacheTask(qc: QC, orgId: string, task: MachineTask) {
  if (!task.threadId) return;
  qc.setQueryData<MachineTask[]>(keys.threadTasks(orgId, task.threadId), (old) =>
    old ? [task, ...old.filter((x) => x.id !== task.id)] : old,
  );
}

function useMissionPart<T>(
  orgId: string,
  missionId: string | null | undefined,
  name: string,
  load: () => Promise<T>,
  enabled = true,
) {
  return useQuery({
    queryKey: keys.missionPart(orgId, missionId ?? "", name),
    queryFn: load,
    enabled: Boolean(missionId) && enabled,
    staleTime: 15_000,
  });
}

export function useMissionDecisions(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "decisions", () => api.missions.decisions(orgId, missionId ?? ""));
}
export function useMissionReviews(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "reviews", () => api.missions.reviews(orgId, missionId ?? ""));
}
export function useMissionFiles(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "files", () => api.missions.files(orgId, missionId ?? ""), enabled);
}
export function useMissionPlan(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "plan", () => api.missions.plan(orgId, missionId ?? ""), enabled);
}
export function useMissionParticipants(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(
    orgId,
    missionId,
    "participants",
    () => api.missions.participants(orgId, missionId ?? ""),
    enabled,
  );
}

/** Refetch what a mission change touches (one part, or all of them). */
export function refreshMission(qc: QC, orgId: string, missionId: string, parts?: string[]) {
  void qc.invalidateQueries({ queryKey: keys.mission(orgId, missionId) });
  void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "thread"] });
  void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "list"] });
  if (!parts) void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "part", missionId] });
  else for (const p of parts) void qc.invalidateQueries({ queryKey: keys.missionPart(orgId, missionId, p) });
}

export function useCreateMission(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: MissionCreateInput) => api.missions.create(orgId, input),
    onSuccess: (mission) => cacheMission(qc, orgId, mission),
  });
}

/** Começar, Pausar, Retomar, Parar. Errors are the caller's to say (translated by code). */
export function useMissionControl(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ missionId, action }: { missionId: string; action: MissionControl }) =>
      api.missions.control(orgId, missionId, action),
    onSuccess: (mission) => {
      cacheMission(qc, orgId, mission);
      void qc.invalidateQueries({ queryKey: keys.threadTasks(orgId, mission.threadId) });
    },
  });
}

export function useCloseMission(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({
      missionId,
      ...input
    }: {
      missionId: string;
      outcome: "done" | "canceled";
      saveToWiki?: boolean;
      note?: string;
    }) => api.missions.close(orgId, missionId, input),
    onSuccess: (mission) => {
      cacheMission(qc, orgId, mission);
      void qc.invalidateQueries({ queryKey: keys.threadInfo(orgId, mission.threadId) });
    },
  });
}

/** Decide, review, suggestions, approve provisional: one mutation that refreshes the mission after. */
export function useMissionAct<I, O>(orgId: string, missionId: string, run: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: run,
    onSuccess: () => refreshMission(qc, orgId, missionId),
  });
}
