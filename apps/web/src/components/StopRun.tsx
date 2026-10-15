import { Button } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ApiError } from "@/api/http";
import { keys } from "@/api/keys";
import type { Message } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { can } from "@/lib/permissions";
import { useLiveStore } from "@/realtime/context";
import type { LiveRun } from "@/realtime/streams";

/** Still working (thinking, writing or running a tool), not stopped yet. */
export const isStoppable = (r: LiveRun) =>
  !r.provisional && (r.status === "thinking" || r.status === "queued" || r.status === "running");

/**
 * "Parar" for a run: who may press it (the person whose message started it,
 * the agent's owner, admins) and the optimistic stop.
 */
export function useStopRun() {
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const live = useLiveStore();
  const dir = useDirectory(org.id);
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onMutate: (runId) => live.stopping(runId, me.user.id),
    onError: (err, runId) => {
      // 409 `run_finished`: it ended on its own meanwhile; its message is on the way (or already here).
      if (err instanceof ApiError && err.status === 409) {
        const r = live.get().streams.runs[runId];
        live.dismiss(runId);
        if (r) void qc.invalidateQueries({ queryKey: keys.messages(org.id, r.channelId) });
        return;
      }
      live.unstopping(runId);
    },
  });
  const startedByMe = (r: LiveRun) => {
    const list = qc.getQueryData<Message[]>(keys.messages(org.id, r.channelId)) ?? [];
    const root = list.find((m) => m.id === (r.triggerMessageId ?? r.threadId));
    return root?.author.type === "person" && root.author.id === me.user.id;
  };
  const canStop = (r: LiveRun) =>
    can(org.role, "manage_agents") || dir.agentById.get(r.agentId)?.ownerUserId === me.user.id || startedByMe(r);
  return { canStop, stop: (r: LiveRun) => stop.mutate(r.runId) };
}

/** The "Parar" button (glass ghost, stop icon; Esc in the conversation does the same). */
export function StopButton({ run, onStop }: { run: LiveRun; onStop: (r: LiveRun) => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="stop"
      className="stop-run"
      title={t("run.stopHint")}
      disabled={run.stopping}
      onClick={() => onStop(run)}
    >
      {run.stopping ? t("run.stopping") : t("run.stop")}
    </Button>
  );
}
