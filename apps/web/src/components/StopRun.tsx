import { Button, Spinner } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ApiError } from "@/api/http";
import { keys } from "@/api/keys";
import type { Message } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { activityVerb, toolActivity } from "@/lib/activity";
import { agentGrammar } from "@/lib/grammar";
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

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

// ── The confirmation ("Parar a tarefa do Rick?"), shared by the bar, the row and Esc ──

interface Confirming {
  runId: string;
  /** Which button it hangs from ("row", "bar", "forum"). */
  place: string;
  /** Opened with Esc at this time: a second Esc within 1.5 s stops directly. */
  viaEscAt: number | null;
}
let confirming: Confirming | null = null;
const confirmListeners = new Set<() => void>();
const setConfirming = (next: Confirming | null) => {
  confirming = next;
  for (const l of confirmListeners) l();
};
export const DOUBLE_ESC_MS = 1500;

/** Opens the confirmation for a run (Esc: anchored to its row or the bar). */
export function askToStop(runId: string, place: string, viaEsc = false) {
  setConfirming({ runId, place, viaEscAt: viaEsc ? Date.now() : null });
}
export const closeStopConfirm = () => setConfirming(null);
/** The confirmation open right now, if any (the page's Esc handler checks it). */
export const stopConfirmOpen = () => confirming;

function useConfirming() {
  return useSyncExternalStore(
    (l) => {
      confirmListeners.add(l);
      return () => {
        confirmListeners.delete(l);
      };
    },
    () => confirming,
    () => null,
  );
}

/** "rodando código há 2 min", "escrevendo a resposta", "pensando há 1 min". */
export function runContext(t: TFunction, run: LiveRun, now = Date.now()) {
  const ago = (since: number | undefined) => {
    const min = Math.floor((now - (since ?? now)) / 60_000);
    return min < 1 ? t("run.ctx.lessThanMin") : t("run.ctx.minutes", { count: min });
  };
  const call = [...(run.work ?? [])].reverse().find((w) => w.kind === "call" && w.running);
  if (call?.kind === "call") {
    const doing = toolActivity(call.tool, call.connector, call.detail);
    return call.code || doing.kind === "runningCode"
      ? t("run.ctx.code", { time: ago(call.since) })
      : t("run.ctx.tool", { doing: activityVerb(t, doing), time: ago(call.since) });
  }
  if (run.text) return t("run.ctx.writing");
  return t("run.ctx.thinking", { time: ago(run.startedAt) });
}

/**
 * The small round "Parar" (stop square in a circle, 28px; a danger tint only
 * on hover; "Parar tarefa · Esc"). A click opens the glass confirmation next
 * to it; after "Parar" it spins with "Parando…".
 */
export function StopButton({
  run,
  onStop,
  place = "row",
}: {
  run: LiveRun;
  onStop: (r: LiveRun) => void;
  place?: string;
}) {
  const { t } = useTranslation();
  const open = useConfirming();
  const isOpen = open?.runId === run.runId && open.place === place;
  return (
    <span className="stop-run-wrap">
      <button
        type="button"
        className="stop-run"
        title={t("run.stopHint")}
        aria-label={run.stopping ? t("run.stopping") : t("run.stop")}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        disabled={run.stopping}
        data-stopping={run.stopping || undefined}
        onClick={() => (isOpen ? closeStopConfirm() : askToStop(run.runId, place))}
      >
        {run.stopping ? <Spinner size={14} /> : <StopGlyph />}
      </button>
      {run.stopping && (
        <span className="stop-run__label small muted" aria-hidden="true">
          {t("run.stopping")}
        </span>
      )}
      {isOpen && open && (
        <StopConfirm
          run={run}
          viaEscAt={open.viaEscAt}
          onCancel={closeStopConfirm}
          onConfirm={() => {
            closeStopConfirm();
            onStop(run);
          }}
        />
      )}
    </span>
  );
}

/** A circle with a rounded square: "stop". */
function StopGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.25" y="7.25" width="5.5" height="5.5" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function StopConfirm({
  run,
  viaEscAt,
  onCancel,
  onConfirm,
}: {
  run: LiveRun;
  viaEscAt: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.agentById.get(run.agentId)?.name ?? t("channel.unknownAgent");
  const panel = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const [now] = useState(() => Date.now());
  // "Parar" has the focus: Enter confirms.
  useEffect(() => {
    stopRef.current?.focus();
  }, []);
  // Esc closes; a second Esc right after the one that opened it stops directly. A click outside closes.
  const latest = useRef({ onCancel, onConfirm, viaEscAt });
  latest.current = { onCancel, onConfirm, viaEscAt };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const { viaEscAt: at, onConfirm: yes, onCancel: no } = latest.current;
      if (at !== null && Date.now() - at <= DOUBLE_ESC_MS) yes();
      else no();
    };
    const onDown = (e: PointerEvent) => {
      const el = panel.current;
      if (el && !el.parentElement?.contains(e.target as Node)) latest.current.onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, []);
  const title = t("run.confirmTitle", agentGrammar(t, name));
  return (
    <div ref={panel} className="stop-confirm" role="dialog" aria-label={title}>
      <p className="stop-confirm__title">{title}</p>
      <p className="stop-confirm__context small muted">
        {capitalize(runContext(t, run, now))}. {t("run.kept")}
      </p>
      <div className="stop-confirm__actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("run.continue")}
        </Button>
        <Button ref={stopRef} size="sm" variant="danger" onClick={onConfirm}>
          {t("run.stop")}
        </Button>
      </div>
      <p className="stop-confirm__hint small muted">{t("run.confirmHint")}</p>
    </div>
  );
}
