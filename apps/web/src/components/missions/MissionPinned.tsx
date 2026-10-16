import { AvatarStack, Button, Icon, Menu, MenuItem, MenuSeparator } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import {
  cacheMission,
  useMissionControl,
  useMissionParticipants,
  useMissionPlan,
  useThreadTasks,
} from "@/api/missions";
import { useMachines } from "@/api/queries";
import type { Mission, MissionControl } from "@/api/types";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { errorText } from "@/lib/errors";
import { cellsFromCounts, formatSpan, isOpenMission, missionTasks, planCells } from "@/lib/missions";
import { useToast } from "@/lib/toast";
import { MachineChip, MissionStatusChip, MissionStrip, useMissionPanel, useNow } from "./MissionBits";
import { CloseMissionDialog, ShareMissionDialog } from "./MissionDialogs";
import { SessionRows } from "./MissionSessions";

/**
 * The mission pinned on top of its thread (ThreadContexto.html, A3–A7): the
 * agent, the title and state, who takes part, "Arquivos", the plan as the
 * pixel strip ("4 de 12 itens"), what runs and what waits for you, how long
 * it has been going, the sessions, and ⋯ (Pausar / Retomar, Parar,
 * Compartilhar, Fechar missão). Controls only for those who may use them.
 */
export function MissionPinned({ mission: m }: { mission: Mission }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const panel = useMissionPanel();
  const plan = useMissionPlan(org.id, m.id);
  const tasks = useThreadTasks(org.id, m.threadId);
  const people = useMissionParticipants(org.id, m.id);
  const control = useMissionControl(org.id);
  const [dialog, setDialog] = useState<"share" | "close" | null>(null);
  const open = isOpenMission(m);
  const offline = Boolean(m.machine && !m.machine.online);
  const now = useNow(open, 30_000);
  const items = plan.data?.current?.items;
  const cells = items ? planCells(items, { offline }) : cellsFromCounts(m.plan, m.runningTasks, { offline });
  const sessions = missionTasks(tasks.data ?? [], m.id);
  const interrupted = sessions.filter((x) => x.status === "interrupted" && !x.endedAt).length;
  const waiting = m.pending.decisions + m.pending.reviews + m.pending.provisional;
  const since = m.startedAt ?? m.createdAt;
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  const act = (action: MissionControl) =>
    control.mutate(
      { missionId: m.id, action },
      {
        onSuccess: (out) => {
          if (action === "stop") {
            toast.show(t("missions.toast.stopped", { count: out.canceledTasks ?? 0 }), "info", {
              label: t("missions.actions.resume"),
              run: () => act("resume"),
            });
          } else toast.show(t(`missions.toast.${action}`));
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  const who = [...(people.data?.owner ? [people.data.owner] : []), ...(people.data?.participants ?? [])];
  const menu = open && (m.canAct || m.canManage);
  return (
    <section className="mi-pinned" aria-label={t("missions.pinned.label", { title: m.title })}>
      <div className="mi-pinned__head">
        <AgentAvatar agentId={m.agentId} name={agentName} size="sm" running={m.runningTasks > 0 && !offline} />
        <span className="mi-pinned__title">
          <span className="mi-pinned__lab">{t("missions.pinned.lab")}</span>
          <b>{m.title}</b>
          <MissionStatusChip mission={m} />
        </span>
        {who.length > 0 && (
          <button
            type="button"
            className="mi-pill"
            onClick={() => setDialog("share")}
            aria-label={t("missions.pinned.people", { count: who.length })}
            title={who.map((p) => p.name).join(", ")}
          >
            <AvatarStack aria-label={who.map((p) => p.name).join(", ")}>
              {who.slice(0, 3).map((p) => (
                <ActorAvatar key={p.userId} actor={{ type: "person", id: p.userId }} name={p.name} size="xs" />
              ))}
            </AvatarStack>
            {who.length > 3 && <small>+{who.length - 3}</small>}
          </button>
        )}
        {panel && (
          <Button size="sm" icon="document" onClick={() => panel.openFiles(m.id, "mission.md")}>
            {t("missions.pinned.files")}
          </Button>
        )}
        {menu && (
          <Menu
            align="end"
            label={t("missions.pinned.more")}
            trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("missions.pinned.more")} />}
          >
            {m.canAct && m.status === "active" && (
              <MenuItem icon="pause" description={t("missions.actions.pauseHint")} onSelect={() => act("pause")}>
                {t("missions.actions.pause")}
              </MenuItem>
            )}
            {m.canAct && m.status === "paused" && (
              <MenuItem icon="play" onSelect={() => act("resume")}>
                {t("missions.actions.resume")}
              </MenuItem>
            )}
            {m.canAct && m.status !== "proposed" && (
              <MenuItem icon="stop" description={t("missions.actions.stopHint")} onSelect={() => act("stop")}>
                {t("missions.actions.stop")}
              </MenuItem>
            )}
            {m.canAct && <MenuSeparator />}
            <MenuItem icon="members" onSelect={() => setDialog("share")}>
              {t("missions.actions.share")}
            </MenuItem>
            {m.canManage && (
              <MenuItem icon="check" onSelect={() => setDialog("close")}>
                {t("missions.actions.close")}
              </MenuItem>
            )}
          </Menu>
        )}
      </div>
      <div className="mi-pinned__strip">
        <b>{t("missions.items", { done: m.plan.done, count: m.plan.total })}</b>
        <MissionStrip
          cells={cells}
          agentId={m.agentId}
          label={t("missions.itemsLabel", { done: m.plan.done, count: m.plan.total })}
        />
      </div>
      <div className="mi-pills mi-pinned__pills">
        {offline && interrupted > 0 ? (
          <span className="mi-pill">
            <Icon name="pause" size={14} />
            {t("missions.pinned.interrupted", { count: interrupted })}
          </span>
        ) : (
          <span className="mi-pill">
            {m.runningTasks > 0 ? (
              <span className="mi-run">
                <Icon name="spinner" size={14} />
              </span>
            ) : (
              <Icon name="pause" size={14} />
            )}
            {m.runningTasks > 0 ? t("missions.pinned.running", { count: m.runningTasks }) : t("missions.pinned.idle")}
          </span>
        )}
        <span className={waiting > 0 && m.canAct ? "mi-pill mi-pill--need" : "mi-pill"}>
          <Icon name={waiting > 0 ? "waiting" : "check"} size={14} />
          {waiting > 0 ? t("missions.pinned.waiting", { count: waiting }) : t("missions.pinned.nothingWaiting")}
        </span>
        {open && (
          <span className="mi-pill">
            <Icon name="clock" size={14} />
            {t("missions.pinned.since", { span: formatSpan(t, (now - Date.parse(since)) / 1000) })}
          </span>
        )}
        {(offline || !m.machine) && <MachineChip machine={m.machine} />}
      </div>
      {m.needsComputer && (
        <div className="mi-notes" style={{ marginTop: 0, marginBottom: 12 }}>
          <Icon name="computer" size={14} />
          <span>{m.role === "owner" ? t("missions.pinned.pickComputer") : t("missions.pinned.waitsComputer")}</span>
          {m.role === "owner" && <PickComputer mission={m} />}
        </div>
      )}
      {sessions.length > 0 && (
        <div className="mi-pinned__sessions">
          <SessionRows tasks={sessions} computer={m.machine?.name} defaultOpen={false} />
        </div>
      )}
      <ShareMissionDialog mission={m} open={dialog === "share"} onOpenChange={(o) => setDialog(o ? "share" : null)} />
      {m.canManage && (
        <CloseMissionDialog mission={m} open={dialog === "close"} onOpenChange={(o) => setDialog(o ? "close" : null)} />
      )}
    </section>
  );
}

/** Handed over without a computer: its new owner points it at one they paired. */
function PickComputer({ mission }: { mission: Mission }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const machines = useMachines(org.id);
  const mine = (machines.data ?? []).filter((x) => x.pairedBy?.id === me.user.id && x.execAllowed);
  return (
    <Menu
      align="end"
      label={t("missions.pinned.chooseComputer")}
      trigger={
        <Button size="sm" icon="computer">
          {t("missions.pinned.chooseComputer")}
        </Button>
      }
    >
      {mine.length === 0 && (
        <MenuItem icon="info" disabled onSelect={() => {}}>
          {t("missions.pinned.noComputers")}
        </MenuItem>
      )}
      {mine.map((x) => (
        <MenuItem
          key={x.id}
          icon="computer"
          description={x.online ? t("missions.online") : t("missions.offline")}
          onSelect={() =>
            void api.missions
              .setMachine(org.id, mission.id, x.id)
              .then((out) => {
                cacheMission(qc, org.id, out);
                toast.show(t("missions.toast.computer", { name: x.name }));
              })
              .catch((error) => toast.show(errorText(t, error), "error"))
          }
        >
          {x.name}
        </MenuItem>
      ))}
    </Menu>
  );
}
