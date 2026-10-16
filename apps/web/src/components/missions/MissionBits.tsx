import { Chip, Icon, type IconName, PlanStrip } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Mission, MissionExecutor, MissionFileName } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import type { PlanCell } from "@/lib/missions";
import { MissionFilesPanel } from "./MissionFiles";
import "./missions.css";

/**
 * Pieces every mission screen shares: the plan strip in the agent's tones,
 * the state chip (an icon and a word, never a dot), the computer chip, a
 * ticking clock, and the files panel any card can open.
 */

/**
 * "Quem programa": Claude Code, Codex (experimental) or the agent itself,
 * only those its computer can run, each with one line on what it means.
 */
export function executorOptions(t: TFunction, executors: MissionExecutor[], agentName: string) {
  return executors.map((e) => ({
    value: e,
    label: t(`missions.executor.${e}` as const, { name: agentName }),
    description: t(`missions.executor.${e}Text` as const, { name: agentName }),
  }));
}

/** Re-renders every `ms` while `active` (live durations). */
export function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** "4 de 12 itens" as pixels, in the mission agent's own tones. */
export function MissionStrip({ cells, agentId, label }: { cells: PlanCell[]; agentId: string; label: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (cells.length === 0) return null;
  return <PlanStrip cells={cells} color={colorOf(dir.agentById.get(agentId))} label={label} />;
}

export type MissionStatusKey = "needsYou" | "proposed" | "working" | "active" | "paused" | "done" | "canceled";

export function missionStatusKey(m: Pick<Mission, "status" | "runningTasks" | "pending" | "canAct">): MissionStatusKey {
  if (m.status === "done" || m.status === "canceled" || m.status === "proposed" || m.status === "paused") {
    return m.status;
  }
  const waiting = m.canAct && m.pending.decisions + m.pending.reviews + m.pending.provisional > 0;
  if (waiting) return "needsYou";
  return m.runningTasks > 0 ? "working" : "active";
}

const STATUS_ICON: Record<MissionStatusKey, IconName> = {
  needsYou: "waiting",
  proposed: "document",
  working: "spinner",
  active: "play",
  paused: "pause",
  done: "check",
  canceled: "close",
};

export function MissionStatusChip({
  mission,
}: {
  mission: Pick<Mission, "status" | "runningTasks" | "pending" | "canAct">;
}) {
  const { t } = useTranslation();
  const key = missionStatusKey(mission);
  return (
    <Chip icon={STATUS_ICON[key]} tone={key === "needsYou" ? "waiting" : "neutral"}>
      {t(`missions.status.${key}`)}
    </Chip>
  );
}

/** "MacBook do Walter · online": neutral (no green), the word says it. */
export function MachineChip({ machine }: { machine: Mission["machine"] }) {
  const { t } = useTranslation();
  return (
    <span className="mi-pill">
      <Icon name="computer" size={14} />
      {machine ? machine.name : t("missions.noComputer")}
      {machine && <small>{machine.online ? t("missions.online") : t("missions.offline")}</small>}
    </span>
  );
}

// ── The files panel, from any card ────────────────────────────────────────────

interface PanelApi {
  openFiles: (missionId: string, tab?: MissionFileName, options?: { diff?: boolean }) => void;
}
const PanelContext = createContext<PanelApi | null>(null);

/** Wraps a conversation: "Arquivos", "Ver plano", "Ver no arquivo" open the same panel. */
export function MissionPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ missionId: string; tab: MissionFileName; diff: boolean } | null>(null);
  const api: PanelApi = {
    openFiles: (missionId, tab = "mission.md", options = {}) =>
      setOpen({ missionId, tab, diff: Boolean(options.diff) }),
  };
  return (
    <PanelContext.Provider value={api}>
      {children}
      {open && (
        <MissionFilesPanel
          missionId={open.missionId}
          tab={open.tab}
          diff={open.diff}
          onTab={(tab) => setOpen((o) => (o ? { ...o, tab, diff: false } : o))}
          onClose={() => setOpen(null)}
        />
      )}
    </PanelContext.Provider>
  );
}

export const useMissionPanel = () => useContext(PanelContext);
