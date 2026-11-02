import { useStopTasks, useTaskManager } from "@agenteschat/client";
import { todayStart } from "@agenteschat/client/lib/task-manager";
import { useIsFocused } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { haptics, useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";

/**
 * A stopped task stays "Parando…" on screen this long after the server took the stop, so it doesn't flash back to
 * its old state before the list asks again; one still listed after it shows what it really is.
 */
const STOPPING_HOLD_MS = 8_000;

/**
 * The task manager with what ended today (ADR 0125), asked again while this screen is on top: every screen that
 * shows it (the list, a task, Agentes' row, a DM's strip) reads the same entry, so moving between them is instant.
 */
export function useTasksToday(options: { enabled?: boolean; pollMs?: number } = {}) {
  const orgId = useOrgId();
  const focused = useIsFocused();
  return useTaskManager(orgId, {
    since: todayStart(),
    enabled: (options.enabled ?? true) && focused,
    ...(options.pollMs ? { pollMs: options.pollMs } : {}),
  });
}

/**
 * "Parar": stops tasks (with the reason the agent reads) and keeps them "Parando…" until they leave the list. Nothing
 * asked for one task; several are confirmed first by the screen that offers them.
 */
export function useStopper() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const { mutate } = useStopTasks(orgId);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const release = useCallback((runIds: readonly string[]) => {
    setStopping((was) => {
      const next = new Set(was);
      for (const id of runIds) next.delete(id);
      return next;
    });
  }, []);
  const stop = useCallback(
    (runIds: readonly string[], reason?: string) => {
      if (runIds.length === 0) return;
      haptics.firm();
      setStopping((was) => new Set([...was, ...runIds]));
      const why = reason?.trim();
      mutate(
        { runIds: [...runIds], ...(why ? { reason: why } : {}) },
        {
          onSuccess: (result) => {
            if (result.failed > 0) toast({ title: t("taskManager.failed"), icon: "x" });
            setTimeout(() => release(runIds), STOPPING_HOLD_MS);
          },
          onError: () => {
            toast({ title: t("taskManager.failed"), icon: "x" });
            release(runIds);
          },
        },
      );
    },
    [mutate, release, toast, t],
  );
  return { stopping, stop };
}
