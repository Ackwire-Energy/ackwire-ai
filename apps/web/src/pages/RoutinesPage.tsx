import type {
  Routine,
  RoutineEvent,
  RoutineHookCall,
  RoutineInput,
  RoutinePatch,
  RoutineReport,
  RoutineRun,
  RoutineTarget,
  RoutineTargetInput,
} from "@agenteschat/client";
import {
  useCalendar,
  useChannels,
  useDms,
  useMachineOutages,
  useMailAccounts,
  useRoutineAction,
  useRoutineHook,
  useRoutineHookAction,
  useRoutineRuns,
  useRoutines,
  useRuleDescribe,
  useRuleParse,
} from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import type { RunStatus } from "@agenteschat/client/lib/calendar";
import { formatBytes } from "@agenteschat/client/lib/files";
import {
  capitalize,
  formatTokensShort,
  formatUsd,
  nextLabel,
  relativeTime,
  toYmd,
  whenAt,
} from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import {
  busyOnComputer,
  healthWords,
  isRunAtWork,
  pausedFix,
  type RoutineFix,
  routineChannelOf,
  routineStateWords,
  runMessageLink,
  runOutcome,
  runPixelStatus,
  runPixels,
  runsPerDay,
  usageParts,
  type Words,
  whereItRuns,
} from "@agenteschat/client/lib/routine-view";
import {
  browserTimezone,
  hookCurl,
  isRefusedHookCall,
  onceParts,
  routineHookUrl,
  timezoneName,
} from "@agenteschat/client/lib/routines";
import {
  Button,
  Checkbox,
  Chip,
  cx,
  DetailsDialog,
  DetailsSection,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FilterBar,
  FilterChip,
  Icon,
  type IconName,
  InfoHint,
  Input,
  Menu,
  RecurrencePicker,
  type RecurrenceRule,
  RunKey,
  RunLane,
  RunStrip,
  SearchField,
  Segmented,
  Select,
  Switch,
  Textarea,
  Toolbar,
  zonedInstant,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { CancelAhead } from "@/components/ApprovalItem";
import { useActors } from "@/components/actors";
import { MenuEntries } from "@/components/DesktopMenus";
import { DetailsLink } from "@/components/details-link";
import { cleanFilter, type EmailTriggerDraft, EmailTriggerFields, emailWhen, INBOX } from "@/components/EmailTrigger";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { SwitchComputerDialog } from "@/components/MachineOutages";
import { CommandBlock } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { RoutineReachWarnings } from "@/components/RoutineReachWarnings";
import { useComputerEdition, useNamesComputers } from "@/components/WorkspaceComputer";
import { ZoneSelect } from "@/components/ZoneSelect";
import { copyText, type MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { defaultRule, fromApiRule, recurrenceLabels, ruleSentence, toApiRule, upcomingLabels } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import "./routines.css";

export const ROUTINE_EVENTS: RoutineEvent[] = [
  "sentry.issue_created",
  "github.pr_opened",
  "issue.created",
  "deploy.succeeded",
];

/** Started by something happening (an event, an email, a webhook call), not by the clock. */
const isEventDriven = (r: Routine) =>
  r.trigger.type === "event" || r.trigger.type === "email" || r.trigger.type === "webhook";
/** An email routine whose mailbox needs reconnecting (or whose watch fails). */
const mailTrouble = (r: Routine) =>
  r.trigger.type === "email" && r.trigger.status && r.trigger.status !== "active" ? r.trigger.status : null;

/** A run of it is working now (Parar stops it). */
const isRunning = (r: Routine) => r.state === "running";
/** A run of it is at work: working, or waiting for a person or its computer. */
const isAtWork = (r: Routine) => isRunning(r) || r.state === "waiting_person" || r.state === "waiting_computer";
/** A one-off that already fired (or was cancelled): no switch, no "Rodar agora", nothing left to run. */
const hasFired = (r: Routine) => r.trigger.type === "once" && !r.active;
/** A one-off that fired and whose run ended: shown muted, under "Concluídos" (while its run works, it is live). */
export const isDoneOnce = (r: Routine) => hasFired(r) && !isAtWork(r);
/** Paused: inactive and not a one-off (a fired one-off is done, or live while its run works). */
const isPaused = (r: Routine) => !r.active && r.trigger.type !== "once";

/** Says the routine's words (`lib/routine-view`): its key and values, else its fallback key. */
function useSay() {
  const { t } = useTranslation();
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (w: Words) => tt(w.key, { ...w.values, ...(w.fallback ? { defaultValue: tt(w.fallback) } : {}) });
}

/** The horizon: the last 4 hours and the next 20. */
const HORIZON_BACK = 4 * 3_600_000;
const HORIZON_AHEAD = 20 * 3_600_000;
const RUN_SLOTS = 14;

/** "now", ticking every minute ("próxima em 10 min" stays true). */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useTargetLabel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  return (target: RoutineTarget) => {
    if (target.type === "channel") {
      const c = channels.data?.find((x) => x.id === target.channelId);
      return c ? `#${c.name}` : "#";
    }
    // From the chat: "na DM com o Jorge", "no #general (thread)".
    if (target.type === "conversation") {
      const dm = dms.data?.find((d) => d.channelId === target.channelId);
      if (dm) return t("routines.inDm", agentGrammar(t, dm.with.name));
      const c = channels.data?.find((x) => x.id === target.channelId);
      if (!c) return t("routines.inConversation");
      return t(target.threadId ? "routines.inThread" : "routines.inChannel", { channel: c.name });
    }
    if (target.type === "forum") return t("routines.target.forumShort");
    return t(target.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
}

const targetIcon = (target: RoutineTarget): IconName =>
  target.type === "dm"
    ? "message"
    : target.type === "conversation"
      ? target.threadId
        ? "reply"
        : "channel"
      : target.type === "forum"
        ? "members"
        : target.type === "artifact"
          ? "file"
          : "channel";

/** The agent's look for the pixel pieces (color and eyes). */
function useLook() {
  const actors = useActors();
  return (agentId: string) => {
    const look = lookOf(actors.dir.agentById.get(agentId));
    return { color: look?.color ?? "sky", eyes: look?.eyes ?? "round" };
  };
}

/** "Quando" in words, in the routine's zone (the zone shows only when it isn't mine). */
function useWhen() {
  const { t, i18n } = useTranslation();
  const { me, org } = useOrg();
  const actors = useActors();
  const mailboxes = useMailAccounts(org.id);
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "UTC";
  return (r: Routine) => {
    if (r.trigger.type === "email") return emailWhen(t, r, mailboxes.data);
    if (r.trigger.type === "webhook") return t("routines.webhook.when");
    const zone = r.trigger.type === "event" ? "" : r.trigger.timezone || "UTC";
    const zoneNote = zone && zone !== myZone ? ` (${timezoneName(zone, i18n.language)})` : "";
    if (r.trigger.type === "schedule")
      return `${
        r.trigger.rule
          ? ruleSentence(t, i18n.language, fromApiRule(r.trigger.rule, toYmd(new Date())), new Date(), false)
          : everyMinutes(t, r.trigger.cron) || r.trigger.description
      }${zoneNote}`;
    if (r.trigger.type === "once")
      return t("routines.once", { ...onceParts(i18n.language, r.trigger.at, zone), zone: zoneNote });
    return t(`routines.event.${r.trigger.event}`);
  };
}

/** Rotinas: scheduled and event-driven agent tasks. */
export function RoutinesPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const routines = useRoutines(org.id);
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  // The routine whose details are open, in the URL (`?open=…`).
  const [openId, setOpenId] = useOpenParam();
  const [showDone, setShowDone] = useState(false);
  const [status, setStatus] = useState<"all" | "active" | "paused" | "event">("all");
  const [q, setQ] = useState("");
  const list = routines.data ?? [];
  const [agents, setAgents] = useState<string[]>([]);
  const copy = useFilterCopy();
  const agentOptions = useActorFilterOptions().filter((o) => o.value.startsWith("agent:"));
  const when = useWhen();
  const query = q.trim().toLowerCase();
  const matches = (r: Routine) =>
    (agents.length === 0 || agents.includes(`agent:${r.agentId}`)) &&
    (!query || `${r.name} ${r.prompt ?? ""} ${when(r)}`.toLowerCase().includes(query));
  const shown = list.filter(matches);
  const current = shown.filter((r) => !isDoneOnce(r));
  const done = shown.filter(isDoneOnce);
  const counts = {
    all: current.length,
    active: current.filter((r) => r.active).length,
    paused: current.filter(isPaused).length,
    event: current.filter(isEventDriven).length,
  };
  const byStatus = (r: Routine) =>
    status === "all" ||
    (status === "active" && r.active) ||
    (status === "paused" && isPaused(r)) ||
    (status === "event" && isEventDriven(r));
  const live = current.filter((r) => byStatus(r) && !isPaused(r));
  const paused = current.filter((r) => byStatus(r) && isPaused(r));
  const open = list.find((r) => r.id === openId) ?? null;
  const toggleOpen = (id: string) => setOpenId(openId === id ? null : id);
  const filtered = agents.length > 0 || query.length > 0 || status !== "all";
  // "N" opens "Nova rotina" (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "n") return;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const group = (title: string, rows: Routine[]) =>
    rows.length > 0 && (
      <section className="routines-group" aria-label={title}>
        <h2 className="routines-group__title">
          {title}
          <span>{rows.length}</span>
        </h2>
        <div className="routines-list">
          {rows.map((r) => (
            <RoutineRow
              key={r.id}
              routine={r}
              now={now}
              selected={r.id === openId}
              onOpen={() => toggleOpen(r.id)}
              onEdit={() => setEditing(r)}
            />
          ))}
        </div>
      </section>
    );
  return (
    <div className="page routines">
      <div className="routines__main">
        <header className="routines-head">
          <div>
            <h1>{t("routines.title")}</h1>
            <p className="routines-head__sub">{t("routines.subtitle")}</p>
          </div>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t("routines.new")}
          </Button>
        </header>
        {routines.isLoading && <LoadingCards count={3} />}
        {routines.isError && !routines.data && (
          <ErrorState error={routines.error} onRetry={() => void routines.refetch()} />
        )}
        {routines.isSuccess && list.length === 0 && (
          <EmptyState
            sky
            title={t("routines.emptyTitle")}
            actions={
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                {t("routines.new")}
              </Button>
            }
          />
        )}
        {list.length > 0 && (
          <>
            <RoutineHorizon routines={list} now={now} onOpen={toggleOpen} />
            <Toolbar
              search={
                <SearchField
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onClear={() => setQ("")}
                  clearLabel={copy.clearSearch}
                  placeholder={t("routines.search")}
                  aria-label={t("routines.search")}
                />
              }
            >
              <Segmented
                label={t("routines.statusLabel")}
                value={status}
                onValueChange={setStatus}
                options={(["all", "active", "paused", "event"] as const).map((v) => ({
                  value: v,
                  label: t(`routines.status.${v}`),
                  count: counts[v],
                }))}
              />
              <FilterBar
                label={t("routines.filters")}
                clearText={copy.clearAll}
                onClear={() => {
                  setAgents([]);
                  setQ("");
                  setStatus("all");
                }}
                filters={[
                  {
                    key: "agents",
                    active: agents.length > 0,
                    node: (
                      <FilterChip
                        label={t("routines.agentFilter")}
                        icon="agent"
                        multiple
                        options={agentOptions}
                        value={agents}
                        onChange={setAgents}
                        valueText={(o) => o.label}
                        countText={copy.people}
                        clearLabel={copy.clearOf(t("routines.agentFilter"))}
                      />
                    ),
                  },
                ]}
              />
            </Toolbar>
            {group(status === "paused" ? t("routines.groupPaused") : t("routines.groupLive"), live)}
            {group(t("routines.groupPaused"), paused)}
            {live.length === 0 && paused.length === 0 && filtered && (
              <EmptyState icon="search" title={t("routines.noResults")} />
            )}
            {done.length > 0 && status === "all" && (
              <section className="routines-group" aria-label={t("routines.done")}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={showDone ? "chevronDown" : "chevronRight"}
                  aria-expanded={showDone}
                  aria-controls="routines-done-list"
                  onClick={() => setShowDone((v) => !v)}
                >
                  {t("routines.doneToggle", { count: done.length })}
                </Button>
                {showDone && (
                  <div id="routines-done-list" className="routines-list">
                    {done.map((r) => (
                      <RoutineRow
                        key={r.id}
                        routine={r}
                        now={now}
                        selected={r.id === openId}
                        onOpen={() => toggleOpen(r.id)}
                        onEdit={() => setEditing(r)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {open && (
        <RoutineDetails routine={open} now={now} onClose={() => setOpenId(null)} onEdit={() => setEditing(open)} />
      )}
      <RoutineDialog open={creating} onClose={() => setCreating(false)} onWebhook={(r) => setOpenId(r.id)} />
      <RoutineDialog
        key={editing?.id ?? "none"}
        open={Boolean(editing)}
        routine={editing ?? undefined}
        onClose={() => setEditing(null)}
        onWebhook={(r) => setOpenId(r.id)}
      />
    </div>
  );
}

/** A title for the card: a routine made from a chat message may be named with its whole prompt. */
export function routineTitle(r: Pick<Routine, "name" | "prompt">) {
  const name = r.name.trim();
  if (name !== (r.prompt ?? "").trim() && name.length <= 80) return name;
  const first = (name.split("\n")[0] ?? name).trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

/** "A cada 30 minutos" for a routine every N minutes (kept as cron `*\/N * * * *`, no rule); "" otherwise. */
function everyMinutes(t: TFunction, cron: string) {
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim())?.[1] ?? (cron.trim() === "* * * * *" ? "1" : null);
  return every ? t("recurrence.s.minutely", { count: Number(every) }) : "";
}

/** The runs as words, for the strip's label and the horizon's tooltips. */
function useRunWords() {
  const { t, i18n } = useTranslation();
  return {
    status: (s: RunStatus) => t(`routines.statusWord.${s}`),
    caption: (r: Routine, now: Date) => {
      if (isRunning(r)) return t("routines.runningNow");
      // The finished runs (one at work is the strip's own "running").
      const runs = runPixels(r.recentRuns.length > 0 ? r.recentRuns : r.lastRun ? [r.lastRun] : []);
      const last = runs[0];
      if (!last) return t("routines.neverRan");
      const silent = runs.filter((x) => x.status === "silent").length;
      if (last.status === "silent" && silent > 1) return t("routines.silentOf", { count: silent, total: runs.length });
      const when = relativeTime(t, i18n.language, last.at, now);
      // A person stopped it: that's no skipped slot (the strip draws both gray).
      if (r.recentRuns[0]?.status === "canceled" && r.recentRuns[0].at === last.at)
        return t("routines.lastRun.stopped", { when });
      return t(`routines.lastRun.${last.status}`, { when });
    },
    label: (r: Routine) => {
      const runs = runPixels(r.recentRuns).slice(0, RUN_SLOTS);
      if (runs.length === 0) return t("routines.stripNone");
      // A sentence per run. The first follows the label's colon, so only the others start with a capital.
      const list = runs.map((x, i) => {
        const when = whenAt(t, i18n.language, x.at);
        return `${i > 0 ? capitalize(when, i18n.language) : when}: ${t(`routines.statusWord.${x.status}`)}`;
      });
      return t("routines.stripLabel", { list: list.join(". ") });
    },
  };
}

/** "Próxima em 10 min" (within a day), else "Próxima sex 16 out, 10:00". */
function useNextText() {
  const { t, i18n } = useTranslation();
  return (r: Routine, now: Date) => {
    if (isRunning(r)) return t("routines.runningNow");
    if (hasFired(r))
      return r.lastRun
        ? t("routines.firedAt", { when: whenAt(t, i18n.language, r.lastRun.at) })
        : t("routines.canceled");
    if (!r.active) return t("routines.paused");
    if (isEventDriven(r)) {
      const week = r.recentRuns.filter((x) => now.getTime() - new Date(x.at).getTime() < 7 * 86_400_000).length;
      if (r.trigger.type === "email")
        return week > 0 ? t("mail.routine.thisWeek", { count: week }) : t("mail.routine.waiting");
      if (week > 0) return t("routines.eventThisWeek", { count: week });
      return t(r.trigger.type === "webhook" ? "routines.webhook.waiting" : "routines.waitingEvent");
    }
    if (!r.nextRunAt) return "";
    const ms = new Date(r.nextRunAt).getTime() - now.getTime();
    if (ms <= 60_000) return t("routines.nextSoon");
    if (ms < 3_600_000)
      return t("routines.nextIn", { when: t("format.inMinutes", { count: Math.floor(ms / 60_000) }) });
    if (ms < 20 * 3_600_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return t("routines.nextIn", {
        when: m ? t("routines.hoursMinutes", { h, m }) : t("format.inHours", { count: h }),
      });
    }
    return t("routines.next", { when: nextLabel(i18n.language, r.nextRunAt) });
  };
}

/** Pause, resume, run, stop, the one-tap fixes and delete: one place for the toasts they say. */
function useRoutineControls(r: Routine) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const toast = useToast();
  const action = useRoutineAction(org.id);
  const running = isRunning(r);
  return {
    action,
    setActive: (active: boolean) =>
      action.mutate(
        { type: "active", id: r.id, active },
        {
          onSuccess: () =>
            toast.show(
              t(active ? "routines.resumedToast" : running ? "routines.pausedRunningToast" : "routines.pausedToast"),
            ),
        },
      ),
    run: () => action.mutate({ type: "run", id: r.id }),
    stop: () => action.mutate({ type: "stop", id: r.id }, { onSuccess: () => toast.show(t("routines.stoppedToast")) }),
    fix: (fix: RoutineFix) => {
      const channelId = routineChannelOf(r.target);
      if (fix === "add_agent" && channelId)
        action.mutate(
          { type: "addAgent", id: r.id, agentId: r.agentId, channelId },
          {
            onSuccess: () =>
              toast.show(t("routines.fix.addedToast", { name: actors.name({ type: "agent", id: r.agentId }) })),
          },
        );
      else if (fix === "take_over")
        action.mutate({ type: "takeOver", id: r.id }, { onSuccess: () => toast.show(t("routines.fix.takenToast")) });
      else
        action.mutate(
          { type: "active", id: r.id, active: true },
          { onSuccess: () => toast.show(t("routines.resumedToast")) },
        );
    },
  };
}

/** The state as a chip ("Pausada: o agente não está mais no canal", "Falhando (3 seguidas)"…). */
function RoutineStateChip({ routine: r, className }: { routine: Routine; className?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const say = useSay();
  const names = useNamesComputers(org.id);
  const since = r.waitingFor ? whenAt(t, i18n.language, r.waitingFor.since) : "";
  const state = routineStateWords(r, since, names);
  return (
    <Chip
      icon={state.icon}
      tone={state.tone}
      className={className}
      lead={r.state === "running" ? <AgentSpinner agentId={r.agentId} /> : undefined}
    >
      {say(state)}
    </Chip>
  );
}

/** The one-tap fix of a paused routine ("Adicionar agente ao canal", "Assumir rotina", "Retomar"). */
function FixButton({ routine: r, fix, size = "sm" }: { routine: Routine; fix: RoutineFix; size?: "sm" }) {
  const { t } = useTranslation();
  const controls = useRoutineControls(r);
  return (
    <Button
      size={size}
      variant={fix === "resume" ? "default" : "primary"}
      icon={fix === "add_agent" ? "plus" : fix === "take_over" ? "person" : "play"}
      loading={controls.action.isPending}
      onClick={() => controls.fix(fix)}
    >
      {t(`routines.fix.${fix}`)}
    </Button>
  );
}

function RoutineRow({
  routine: r,
  now,
  selected,
  onOpen,
  onEdit,
}: {
  routine: Routine;
  now: Date;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const toast = useToast();
  const controls = useRoutineControls(r);
  const action = controls.action;
  const [deleting, setDeleting] = useState(false);
  const target = useTargetLabel();
  const when = useWhen();
  const nextText = useNextText();
  const words = useRunWords();
  const look = useLook()(r.agentId);
  const agent = { type: "agent" as const, id: r.agentId };
  const title = routineTitle(r);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const done = isDoneOnce(r);
  const fired = hasFired(r);
  const paused = isPaused(r);
  const running = isRunning(r);
  const more = t("routines.more", { name: title });
  // Something needs a look (a reason it paused, failures, waiting for a computer or a person): a chip says it.
  const needsLook = !done && routineStateWords(r).tone === "waiting";
  const fix = r.canManage && needsLook ? pausedFix(r) : null;
  // Its "…" and its right click: run or stop, pause or resume, then what the "…" always had.
  const entries = (): MenuEntry[] => [
    ...(r.canManage && !reminder && (running || !fired)
      ? ([
          running
            ? { kind: "item", id: "stop", label: t("routines.stop"), icon: "stop", run: controls.stop }
            : { kind: "item", id: "run", label: t("routines.runNow"), icon: "play", run: controls.run },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage && !fired
      ? ([
          r.active
            ? {
                kind: "item",
                id: "pause",
                label: t("routines.pause"),
                icon: "pause",
                run: () => controls.setActive(false),
              }
            : {
                kind: "item",
                id: "resume",
                label: t("routines.resume"),
                icon: "play",
                run: () => controls.setActive(true),
              },
          { kind: "separator" },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage
      ? ([{ kind: "item", id: "edit", label: t("routines.edit"), icon: "edit", run: onEdit }] satisfies MenuEntry[])
      : []),
    { kind: "item", id: "runs", label: t("routines.runs"), icon: "waiting", run: () => !selected && onOpen() },
    ...(r.canManage
      ? ([
          {
            kind: "item",
            id: "duplicate",
            label: t("routines.duplicate"),
            icon: "copy",
            run: () =>
              action.mutate(
                { type: "duplicate", id: r.id, name: t("routines.copyName", { name: r.name }) },
                {
                  onSuccess: (copy) =>
                    toast.show(t("routines.duplicated", { name: (copy as Routine | undefined)?.name ?? r.name })),
                },
              ),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage && routineHookUrl(r)
      ? ([
          {
            kind: "item",
            id: "webhook",
            label: t("routines.copyWebhook"),
            icon: "link",
            run: () => void copyText(routineHookUrl(r) ?? "", () => toast.show(t("routines.webhookCopied"))),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage
      ? ([
          { kind: "item", id: "delete", label: t("routines.delete"), icon: "trash", run: () => setDeleting(true) },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a mouse shortcut; the title is the keyboard way to the details
    <article
      className={cx("routine-row", selected && "routine-row--on")}
      aria-label={title}
      data-active={r.active || undefined}
      data-paused={paused || undefined}
      data-done={done || undefined}
      data-running={running || undefined}
      data-state={r.state}
      {...entityMenu(() => [{ kind: "header", label: title }, ...entries()])}
      onClick={(e) => {
        // The row opens the details; its own controls don't.
        if ((e.target as HTMLElement).closest("button, a, [role=switch], [role=menu]")) return;
        onOpen();
      }}
    >
      <span className="routine-row__who">{actors.avatar(agent, "sm")}</span>
      <div className="routine-row__main">
        <button type="button" className="routine-row__title" title={r.name} aria-expanded={selected} onClick={onOpen}>
          {title}
        </button>
        <span className="routine-row__sub">
          <Icon name={targetIcon(r.target)} size={14} />
          <span>
            {r.target.type === "conversation"
              ? t("routines.deliversIn", { agent: actors.name(agent), place: target(r.target) })
              : t("routines.deliversTo", { agent: actors.name(agent), target: target(r.target) })}
          </span>
          {reminder && (
            <Chip icon="bell" className="routine-row__chip">
              {t("routines.reminder")}
            </Chip>
          )}
          {mailTrouble(r) && (
            <Chip icon="alert" tone="waiting" className="routine-row__chip">
              {t(mailTrouble(r) === "error" ? "mail.routine.error" : "mail.routine.needsReconnect")}
            </Chip>
          )}
          {needsLook && <RoutineStateChip routine={r} className="routine-row__chip" />}
          {fix && fix !== "resume" && <FixButton routine={r} fix={fix} />}
        </span>
      </div>
      <div className="routine-row__when ac-iconline">
        <span className="routine-row__when-icon" aria-hidden="true">
          <Icon
            name={
              r.trigger.type === "event"
                ? "bolt"
                : r.trigger.type === "email"
                  ? "mail"
                  : r.trigger.type === "webhook"
                    ? "link"
                    : r.trigger.type === "once"
                      ? reminder
                        ? "bell"
                        : "calendar"
                      : "repeat"
            }
            size={16}
          />
        </span>
        <span className="routine-row__when-text">
          <b>{when(r)}</b>
          <small className={cx(running && "is-live")}>{nextText(r, now)}</small>
        </span>
      </div>
      <div className="routine-row__runs" role="img" aria-label={words.label(r)}>
        <RunStrip runs={runPixels(r.recentRuns)} color={look.color} slots={RUN_SLOTS} running={running} />
        <small>{words.caption(r, now)}</small>
      </div>
      <div className="routine-row__actions">
        {fired || !r.canManage ? (
          <span className="routine-row__ph routine-row__ph--switch" aria-hidden="true" />
        ) : (
          <Switch
            checked={r.active}
            onCheckedChange={controls.setActive}
            aria-label={t("routines.activeLabel", { name: title })}
          />
        )}
        {/* Parar for a run at work, also a paused routine's or a fired one-off's; "Rodar agora" while it may run. */}
        {(running || !fired) && !reminder && r.canManage ? (
          running ? (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="stop"
              title={t("routines.stop")}
              aria-label={t("routines.stopName", { name: title })}
              disabled={action.isPending}
              onClick={controls.stop}
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="play"
              title={t("routines.runNow")}
              aria-label={t("routines.runNow")}
              disabled={action.isPending}
              onClick={controls.run}
            />
          )
        ) : (
          <span className="routine-row__ph" aria-hidden="true" />
        )}
        <Menu
          align="end"
          label={more}
          trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={more} />}
        >
          <MenuEntries entries={entries()} />
        </Menu>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title={t("routines.deleteTitle", { name: title })}
        description={running ? t("routines.deleteBodyRunning") : t("routines.deleteBody")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={action.isPending && action.variables?.type === "delete"}
            onClick={() =>
              action.mutate(
                { type: "delete", id: r.id },
                {
                  onSuccess: () => {
                    setDeleting(false);
                    toast.show(t("routines.deleted"));
                  },
                },
              )
            }
          >
            {t("routines.deleteConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </article>
  );
}

/**
 * The next hours as a horizon: one lane per scheduled routine, its recent runs
 * as pixel columns, the next run as the agent's sprite on the line, "agora" as
 * a dotted pixel line. Future slots come from the calendar range (the server's
 * schedule math).
 */
function RoutineHorizon({ routines, now, onOpen }: { routines: Routine[]; now: Date; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const look = useLook();
  const words = useRunWords();
  // The window moves with the minute; the slots are asked once per hour (the calendar caches by start).
  const hour = Math.floor(now.getTime() / 3_600_000);
  const range = useMemo(() => {
    const start = new Date(hour * 3_600_000);
    return { from: start.toISOString(), to: new Date(start.getTime() + HORIZON_AHEAD + 3_600_000).toISOString() };
  }, [hour]);
  const slots = useCalendar(org.id, range.from, range.to);
  const from = new Date(now.getTime() - HORIZON_BACK);
  const to = new Date(now.getTime() + HORIZON_AHEAD);
  const lanes = routines.filter((r) => r.active && !isDoneOnce(r) && !isEventDriven(r));
  if (lanes.length === 0) return null;
  const futureOf = (r: Routine) => {
    const at = (slots.data?.routines ?? [])
      .filter((s) => s.routineId === r.id && new Date(s.at) > now && new Date(s.at) <= to)
      .map((s) => s.at);
    // Before the calendar answers, the next run alone.
    if (at.length === 0 && r.nextRunAt && new Date(r.nextRunAt) <= to) return [r.nextRunAt];
    return at.sort();
  };
  const pos = (d: Date) => ((d.getTime() - from.getTime()) / (to.getTime() - from.getTime())) * 100;
  const scale: { at: Date; label: string; day: boolean }[] = [];
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  first.setHours(Math.ceil(first.getHours() / 3) * 3);
  for (let d = new Date(first); d <= to; d = new Date(d.getTime() + 3 * 3_600_000)) {
    const p = pos(d);
    if (p < 3 || p > 97 || Math.abs(d.getTime() - now.getTime()) < 1.2 * 3_600_000) continue;
    const midnight = d.getHours() === 0;
    scale.push({
      at: d,
      day: midnight,
      label: midnight
        ? new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\./g, "")
        : new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(d),
    });
  }
  const timeOf = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const later = lanes.filter((r) => futureOf(r).length === 0).length;
  const nowAt = pos(now);
  return (
    <section className="routines-horizon" aria-label={t("routines.horizon.label")}>
      <div className="routines-horizon__head">
        <h2>{t("routines.horizon.title", { count: HORIZON_AHEAD / 3_600_000 })}</h2>
        <span className="routines-horizon__sub">
          {t("routines.horizon.lanes", { count: lanes.length })}
          {later > 0 && ` · ${t("routines.horizon.later", { count: later })}`}
        </span>
        <span className="routines-horizon__legend" aria-hidden="true">
          {(["ok", "silent", "failed", "next"] as const).map((k) => (
            <span key={k}>
              <RunKey status={k} />
              {t(`routines.horizon.legend.${k}`)}
            </span>
          ))}
        </span>
      </div>
      <div className="routines-horizon__body" style={{ "--now-k": nowAt / 100 } as CSSProperties}>
        <span />
        <div className="routines-horizon__scale" aria-hidden="true">
          {scale.map((s) => (
            <span key={s.at.getTime()} style={{ left: `${pos(s.at)}%` }} className={cx(s.day && "is-day")}>
              {s.label}
            </span>
          ))}
        </div>
        {lanes.map((r) => {
          const future = futureOf(r);
          const next = future[0];
          const soon = next && new Date(next).getTime() - now.getTime() < 3_600_000;
          const hourly = r.trigger.type === "schedule" && r.trigger.rule?.freq === "hourly";
          const { color, eyes } = look(r.agentId);
          const title = routineTitle(r);
          return (
            <div className="routines-horizon__lane" key={r.id}>
              <button type="button" className="routines-horizon__label" title={title} onClick={() => onOpen(r.id)}>
                <AgentFace agentId={r.agentId} />
                <b>{title}</b>
              </button>
              <div
                className="routines-horizon__track"
                role="img"
                aria-label={
                  next
                    ? t("routines.horizon.lane", { name: title, when: whenAt(t, i18n.language, next) })
                    : t("routines.horizon.laneNone", { name: title })
                }
                title={words.label(r)}
              >
                <RunLane
                  from={from}
                  to={to}
                  now={now}
                  color={color}
                  eyes={eyes}
                  running={isRunning(r)}
                  past={runPixels(r.recentRuns).filter((x) => new Date(x.at) >= from && new Date(x.at) <= now)}
                  future={future}
                />
                {next && !isRunning(r) && (!hourly || soon) && (
                  <span
                    className={cx("routines-horizon__next", soon && "is-soon")}
                    style={{ left: `max(${pos(new Date(next))}%, calc(${nowAt}% + 12px))` }}
                  >
                    {soon
                      ? t("format.inMinutes", {
                          count: Math.max(1, Math.floor((new Date(next).getTime() - now.getTime()) / 60_000)),
                        })
                      : timeOf(next)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <span className="routines-horizon__past" aria-hidden="true" />
        <span className="routines-horizon__now" aria-hidden="true">
          <span>{t("routines.horizon.now")}</span>
        </span>
      </div>
    </section>
  );
}

function AgentFace({ agentId }: { agentId: string }) {
  const actors = useActors();
  return actors.avatar({ type: "agent", id: agentId }, "xs");
}

/**
 * A routine's details over whatever page is open (`DetailsHost`): the chat's routine tag, an agent's receipts,
 * the calendar. "Editar" opens the routine's form there too.
 */
export function RoutineDetailsDialog({ routineId, onClose }: { routineId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const routines = useRoutines(org.id);
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const routine = routines.data?.find((r) => r.id === routineId);
  // Gone, or not one the viewer may see: says so and closes.
  const gone = routines.isError || (routines.isSuccess && !routine);
  useEffect(() => {
    if (!gone) return;
    toast.show(t("routines.notFound"), "error");
    onClose();
  }, [gone, toast, t, onClose]);
  if (!routine) return null;
  return (
    <>
      <RoutineDetails routine={routine} now={now} onClose={onClose} onEdit={() => setEditing(true)} />
      <RoutineDialog
        key={editing ? "edit" : "none"}
        open={editing}
        onClose={() => setEditing(false)}
        routine={routine}
      />
    </>
  );
}

/**
 * The routine's details: its state, the week, what it does, when, where, how it works and its runs. Where it runs
 * only where the workspace has more than one computer, by its name. Short sections sit two to a row when the dialog
 * is wide enough (`routine-details__pair`).
 */
function RoutineDetails({
  routine: r,
  now,
  onClose,
  onEdit,
}: {
  routine: Routine;
  now: Date;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const controls = useRoutineControls(r);
  const action = controls.action;
  const runs = useRoutineRuns(org.id, r.id);
  const target = useTargetLabel();
  const when = useWhen();
  const nextText = useNextText();
  const say = useSay();
  const outages = useMachineOutages(org.id, r.state === "waiting_computer");
  const [switching, setSwitching] = useState(false);
  const agent = { type: "agent" as const, id: r.agentId };
  const name = actors.name(agent);
  const title = routineTitle(r);
  const done = isDoneOnce(r);
  const fired = hasFired(r);
  const running = isRunning(r);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const described = useRuleDescribe(
    org.id,
    r.active && r.trigger.type === "schedule" && r.trigger.rule ? r.trigger.rule : null,
  );
  const nexts = described.data?.ok ? described.data.nextRuns.slice(0, 4) : r.nextRunAt ? [r.nextRunAt] : [];
  const fix = r.canManage ? pausedFix(r) : null;
  // "Trocar computador": the outage its run waits on, for whoever can move agents, where people connect their own
  // computers (a Cloud workspace has one).
  const selfHost = useComputerEdition(org.id) === "selfhost";
  const outage =
    selfHost && r.state === "waiting_computer" && r.waitingFor && can(org, "manage_agents")
      ? outages.data?.outages.find((o) => o.machineId === r.waitingFor?.machineId)
      : undefined;
  const health = healthWords(r.health);
  const usage = usageParts(r.usage, can(org, "view_usage"));
  const usageText = usage
    ? [
        t("routines.usage.runs", { count: usage.runs }),
        usage.tokens !== null
          ? t("routines.usage.tokens", { tokens: formatTokensShort(t, i18n.language, usage.tokens) })
          : null,
        usage.costUsd !== null ? t("routines.usage.cost", { cost: formatUsd(t, i18n.language, usage.costUsd) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const namesComputer = useNamesComputers(org.id);
  const runsOn = whereItRuns(r.brain, namesComputer);
  const perDay = r.trigger.type === "schedule" ? runsPerDay(r.trigger.rule ?? null, r.trigger.cron) : 0;
  const busy = r.active ? busyOnComputer(r.brain, perDay, { selfHost, namesComputer }) : null;
  const whereHint =
    r.target.type === "conversation"
      ? r.target.threadId
        ? "thread"
        : "channel"
      : r.target.type === "dm"
        ? "dm"
        : r.target.type;
  const list = runs.data ?? r.recentRuns;
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("routines.panel.close")}
      className="routine-details"
      eyebrow={t("routines.panel.eyebrow")}
      icon={<AgentAvatar agentId={r.agentId} name={name} size="md" running={running} />}
      title={title}
      subtitle={
        <>
          <span>{name}</span>
          {done ? <Chip icon="check">{t("routines.panel.state.done")}</Chip> : <RoutineStateChip routine={r} />}
        </>
      }
    >
      {r.canManage && (
        <div className="routine-details__actions">
          {fix && fix !== "resume" && <FixButton routine={r} fix={fix} />}
          {outage && outages.data && (
            <Button size="sm" variant="primary" icon="computer" onClick={() => setSwitching(true)}>
              {t("outage.switch")}
            </Button>
          )}
          <Button size="sm" icon="edit" onClick={onEdit}>
            {t("routines.edit")}
          </Button>
          {(running || !fired) &&
            !reminder &&
            (running ? (
              <Button size="sm" icon="stop" disabled={action.isPending} onClick={controls.stop}>
                {t("routines.stop")}
              </Button>
            ) : (
              <Button size="sm" icon="play" disabled={action.isPending} onClick={controls.run}>
                {t("routines.runNow")}
              </Button>
            ))}
          {!fired && (
            <Button size="sm" icon={r.active ? "pause" : "play"} onClick={() => controls.setActive(!r.active)}>
              {r.active ? t("routines.panel.pause") : t("routines.resume")}
            </Button>
          )}
        </div>
      )}
      {outage && outages.data && (
        <SwitchComputerDialog open={switching} onOpenChange={setSwitching} outage={outage} data={outages.data} />
      )}
      <div className="routine-details__pair">
        <DetailsSection title={t("routines.panel.week")}>
          <p className="routine-details__sentence">
            {health ? health.map(say).join(" · ") : t("routines.health.none")}
          </p>
          {usageText && <p className="small muted">{`${t("routines.panel.usage")}: ${usageText}`}</p>}
        </DetailsSection>
        <DetailsSection title={t("routines.panel.where")}>
          <div className="routine-details__where">
            <span className="routine-details__where-icon">
              <Icon name={targetIcon(r.target)} size={16} />
            </span>
            <span>
              <b>{target(r.target)}</b>
              <small>{t(`routines.panel.whereHint.${whereHint}`)}</small>
            </span>
          </div>
        </DetailsSection>
      </div>
      {runsOn && (
        <DetailsSection title={t("routines.panel.runsOn")}>
          <p className="routine-details__sentence">{runsOn}</p>
        </DetailsSection>
      )}
      <DetailsSection title={t("routines.panel.what", agentGrammar(t, name))}>
        {r.canSeeDetails && r.prompt !== null ? (
          <p className="routine-details__prompt">{r.prompt}</p>
        ) : (
          <p className="small muted">{t("routines.detailsHidden")}</p>
        )}
      </DetailsSection>
      <DetailsSection title={t("routines.panel.when")}>
        <p className="routine-details__sentence">{when(r)}</p>
        {mailTrouble(r) && (
          <Chip icon="alert" tone="waiting">
            {t(mailTrouble(r) === "error" ? "mail.routine.error" : "mail.routine.needsReconnect")}
          </Chip>
        )}
        {r.trigger.type === "email" ? (
          <p className="small muted">{t("mail.routine.every")}</p>
        ) : r.trigger.type === "webhook" ? (
          <p className="small muted">{t("routines.webhook.every")}</p>
        ) : r.trigger.type === "event" ? (
          <p className="small muted">{t("routines.panel.eventEvery")}</p>
        ) : (
          nexts.length > 0 &&
          !done && (
            <div className="routine-details__nexts">
              {nexts.map((iso) => (
                <span key={iso}>{nextLabel(i18n.language, iso)}</span>
              ))}
            </div>
          )
        )}
        {!done && <p className="small muted">{nextText(r, now)}</p>}
        {busy && (
          <p className="routine-note small ac-iconline">
            <Icon name="computer" size={14} />
            <span>{say(busy)}</span>
          </p>
        )}
      </DetailsSection>
      {r.trigger.type === "webhook" && (
        <DetailsSection title={t("routines.form.kind.webhook")}>
          {r.canManage ? (
            <WebhookPanel routine={r} runs={list} />
          ) : (
            <p className="small muted">{t("routines.webhook.hidden")}</p>
          )}
        </DetailsSection>
      )}
      {r.ahead && r.ahead.length > 0 && (
        <DetailsSection title={t("routines.panel.ahead")}>
          <ul className="routine-ahead">
            {r.ahead.map((a) => (
              <li key={a.id} className="routine-details__where routine-ahead__item">
                <span className="routine-details__where-icon">
                  <Icon name={a.status === "approved" ? "calendar" : "waiting"} size={16} />
                </span>
                <span className="routine-ahead__text">
                  <Link
                    to="/org/$orgId/approvals"
                    params={{ orgId: org.id }}
                    search={{ open: a.id }}
                    className="routine-ahead__title"
                  >
                    {approvalTitle(t, { ...a, email: null })}
                  </Link>
                  <small>
                    {t(a.status === "approved" ? "routines.ahead.approved" : "routines.ahead.pending", {
                      when: nextLabel(i18n.language, a.runAt),
                    })}
                  </small>
                </span>
                {a.canCancel && (
                  <span className="ac-acts">
                    <CancelAhead id={a.id} />
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="small muted">{t("routines.ahead.hint")}</p>
        </DetailsSection>
      )}
      <DetailsSection title={t("routines.panel.report")}>
        <p className="routine-details__sentence">
          <span className="ac-hintline">
            {t(`routines.report.${r.report}`)}
            <InfoHint name={t("common.about", { label: t("routines.panel.report") })}>
              {t("routines.report.hint")}
            </InfoHint>
          </span>
        </p>
      </DetailsSection>
      <DetailsSection title={t("routines.panel.runs")}>
        {runs.isLoading && list.length === 0 && <LoadingList count={3} avatar={false} />}
        {list.length > 0 && (
          <ol className="routine-runs">
            {list.slice(0, 30).map((x) => (
              <RunItem key={x.id} run={x} routine={r} />
            ))}
          </ol>
        )}
        {runs.isSuccess && list.length === 0 && (
          <p className="small muted">
            {t("routines.noRuns")}
            {nexts[0] && !done && ` ${t("routines.panel.firstRun", { when: nextLabel(i18n.language, nexts[0]) })}`}
          </p>
        )}
      </DetailsSection>
    </DetailsDialog>
  );
}

const RUN_NODE_ICON: Record<RunStatus, IconName> = { ok: "check", silent: "dash", failed: "close", skipped: "pause" };

/**
 * One run: its outcome in plain words ("Contou o que achou", "Pulada: a anterior ainda estava rodando",
 * "Parada por Walter"), the agent's words when the viewer may read them, and where to go: the agent's
 * message ("Abrir na conversa") or the approval it waits for.
 */
function RunItem({ run: x, routine: r }: { run: RoutineRun; routine: Routine }) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const say = useSay();
  const pixel = runPixelStatus(x.status);
  const outcome = say(runOutcome(x, (id) => actors.dir.memberById.get(id)?.name ?? null));
  const words = r.canSeeDetails && (x.status === "reported" || x.status === "silent") ? x.summary.trim() : "";
  return (
    <li className="routine-runs__item">
      <span className={`routine-runs__node routine-runs__node--${pixel ?? "running"}`}>
        <Icon name={pixel ? RUN_NODE_ICON[pixel] : isRunAtWork(x.status) ? "play" : "dash"} size={14} />
      </span>
      <span>
        {x.status === "waiting" && x.approvalId ? (
          <DetailsLink item={{ kind: "approval", id: x.approvalId }} className="routine-runs__link">
            {outcome}
          </DetailsLink>
        ) : (
          <b>{outcome}</b>
        )}
        {words && <small>{words}</small>}
        <RunChatLink run={x} />
      </span>
      <time dateTime={x.at}>{whenAt(t, i18n.language, x.at)}</time>
    </li>
  );
}

/** "Abrir na conversa": the agent's message a run left (its report), when it left one. */
function RunChatLink({ run }: { run: RoutineRun }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const link = runMessageLink(run);
  if (!link) return null;
  return link.threadId ? (
    <Link
      to="/org/$orgId/threads/$threadId"
      params={{ orgId: org.id, threadId: link.threadId }}
      className="routine-runs__open"
    >
      {t("routines.openInChat")}
    </Link>
  ) : (
    <Link
      to="/org/$orgId/c/$channelId"
      params={{ orgId: org.id, channelId: link.channelId }}
      search={{ m: link.messageId }}
      className="routine-runs__open"
    >
      {t("routines.openInChat")}
    </Link>
  );
}

/**
 * A webhook routine's address (ADR 0106), for who manages it: the address to copy and a new one (the old stops at
 * once), the signing secret (shown once, replaced or turned off), an example call, Testar, and the latest calls with
 * the run each went into.
 */
function WebhookPanel({ routine: r, runs }: { routine: Routine; runs: RoutineRun[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const hook = useRoutineHook(org.id, r.id);
  const action = useRoutineHookAction(org.id, r.id);
  const [secret, setSecret] = useState<string | null>(null);
  const [asking, setAsking] = useState<"address" | "secret" | "unsign" | null>(null);
  const data = hook.data;
  if (!data) {
    return hook.isError ? (
      <ErrorState error={hook.error} onRetry={() => void hook.refetch()} />
    ) : (
      <LoadingList count={1} avatar={false} />
    );
  }
  const busy = (what: "address" | "secret" | "unsign" | "test") => action.isPending && action.variables === what;
  const change = (what: "address" | "secret" | "unsign") =>
    action.mutate(what, {
      onSuccess: (done) => {
        setAsking(null);
        if (what === "address") toast.show(t("routines.webhook.replaced"));
        else setSecret(done.secret ?? null);
      },
    });
  return (
    <div className="routine-hook">
      <div className="routine-hook__part">
        <span className="ac-field__label">{t("routines.webhook.address")}</span>
        <CommandBlock command={data.url} copied={t("routines.webhook.copied")} />
        <p className="small muted">{t("routines.webhook.addressHelp")}</p>
        {asking === "address" ? (
          <HookQuestion
            text={t("routines.webhook.replaceBody")}
            action={t("routines.webhook.replace")}
            loading={busy("address")}
            onCancel={() => setAsking(null)}
            onConfirm={() => change("address")}
          />
        ) : (
          <div className="routine-hook__actions">
            <Button type="button" size="sm" icon="refresh" onClick={() => setAsking("address")}>
              {t("routines.webhook.replace")}
            </Button>
          </div>
        )}
      </div>
      <div className="routine-hook__part">
        <span className="ac-hintline">
          <span className="ac-field__label">{t("routines.webhook.signature")}</span>
          <InfoHint name={t("common.about", { label: t("routines.webhook.signature") })}>
            {t("routines.webhook.signedHelp")}
          </InfoHint>
        </span>
        <p className="small">{t(data.signed ? "routines.webhook.signedOn" : "routines.webhook.signedOff")}</p>
        {secret && data.signed && (
          <>
            <p className="routine-note small ac-iconline" role="status">
              <Icon name="key" size={14} />
              <span>{t("routines.webhook.secretOnce")}</span>
            </p>
            <CommandBlock command={secret} copied={t("routines.webhook.secretCopied")} />
          </>
        )}
        {asking === "secret" || asking === "unsign" ? (
          <HookQuestion
            text={t(asking === "secret" ? "routines.webhook.newSecretBody" : "routines.webhook.removeSecretBody")}
            action={t(asking === "secret" ? "routines.webhook.newSecret" : "routines.webhook.removeSecret")}
            loading={busy(asking)}
            onCancel={() => setAsking(null)}
            onConfirm={() => change(asking)}
          />
        ) : (
          <div className="routine-hook__actions">
            <Button
              type="button"
              size="sm"
              icon="key"
              loading={busy("secret")}
              onClick={() => (data.signed ? setAsking("secret") : change("secret"))}
            >
              {t(data.signed ? "routines.webhook.newSecret" : "routines.webhook.addSecret")}
            </Button>
            {data.signed && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setAsking("unsign")}>
                {t("routines.webhook.removeSecret")}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="routine-hook__part">
        <span className="ac-field__label">{t("routines.webhook.example")}</span>
        <CommandBlock
          command={hookCurl(data.url, data.signed ? (secret ?? t("routines.webhook.secretPlaceholder")) : null)}
          copied={t("routines.webhook.exampleCopied")}
        />
        <div className="routine-hook__actions">
          <Button
            type="button"
            size="sm"
            icon="send"
            loading={busy("test")}
            onClick={() => action.mutate("test", { onSuccess: () => toast.show(t("routines.webhook.tested")) })}
          >
            {t("routines.webhook.test")}
          </Button>
        </div>
      </div>
      <div className="routine-hook__part">
        <span className="ac-field__label">{t("routines.webhook.calls")}</span>
        {data.calls.length === 0 ? (
          <p className="small muted">{t("routines.webhook.noCalls")}</p>
        ) : (
          <ol className="routine-runs" aria-label={t("routines.webhook.calls")}>
            {data.calls.map((c) => (
              <HookCallItem key={c.id} call={c} run={runs.find((x) => x.id === c.runId)} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** A change that breaks the services calling the address, asked in place of its buttons: what stops working. */
function HookQuestion(props: {
  text: string;
  action: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="routine-hook__confirm" role="alert">
      <p className="small">{props.text}</p>
      <div className="routine-hook__actions">
        <Button type="button" size="sm" onClick={props.onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" variant="danger" loading={props.loading} onClick={props.onConfirm}>
          {props.action}
        </Button>
      </div>
    </div>
  );
}

/** One call: how it ended, its size, Teste when Testar sent it, and the agent's message of the run it went into. */
function HookCallItem({ call: c, run }: { call: RoutineHookCall; run: RoutineRun | undefined }) {
  const { t, i18n } = useTranslation();
  const refused = isRefusedHookCall(c.outcome);
  return (
    <li className="routine-runs__item">
      <span className={`routine-runs__node routine-runs__node--${refused ? "failed" : "ok"}`}>
        <Icon name={refused ? "close" : "check"} size={14} />
      </span>
      <span>
        <b>
          {[
            t(`routines.webhook.outcome.${c.outcome}`),
            ...(c.bytes > 0 ? [formatBytes(i18n.language, c.bytes)] : []),
            ...(c.test ? [t("routines.webhook.callTest")] : []),
          ].join(" · ")}
        </b>
        {run && <RunChatLink run={run} />}
      </span>
      <time dateTime={c.at}>{whenAt(t, i18n.language, c.at)}</time>
    </li>
  );
}

/** Starting points for "Nova rotina" (the words come from i18n; the phrase is read by the server). */
const PRESETS = [
  { key: "digest", icon: "file", kind: "schedule" },
  { key: "errors", icon: "alert", kind: "schedule" },
  { key: "prs", icon: "bolt", kind: "event", event: "github.pr_opened" },
  { key: "week", icon: "calendar", kind: "schedule" },
] as const satisfies readonly { key: string; icon: IconName; kind: "schedule" | "event"; event?: RoutineEvent }[];

const TARGET_DM = "dm";
const TARGET_ARTIFACT = "artifact";
const TARGET_FORUM = "forum";
/** Editing a routine made in the chat (a thread or DM): keep where it delivers. */
const TARGET_KEEP = "keep";
const FORUM_ROUNDS = ["1", "2", "3", "5"] as const;

/** Where a routine delivers, as the form's select value. */
function targetChoice(target: RoutineTarget | undefined): string {
  if (!target) return "";
  if (target.type === "channel") return target.channelId;
  if (target.type === "dm") return TARGET_DM;
  if (target.type === "artifact") return TARGET_ARTIFACT;
  if (target.type === "forum") return TARGET_FORUM;
  return TARGET_KEEP;
}

/** The phrase the routine was written with, as the person wrote it (made with the picker, or new: none). */
const phraseOf = (r: Routine | undefined) => (r?.trigger.type === "schedule" ? (r.trigger.phrase ?? "") : "");

/** The rule a routine runs on, in `zone` (new, or an old cron-only routine: Mondays at 09:00). */
function ruleOf(r: Routine | undefined, zone: string): RecurrenceRule {
  const base = defaultRule(zone);
  if (r?.trigger.type === "once") return onceRule(r.trigger.at, zone);
  if (r?.trigger.type === "schedule" && r.trigger.rule)
    return { ...fromApiRule(r.trigger.rule, base.start), timezone: zone };
  if (r?.trigger.type === "schedule") return base;
  const { timezone, start } = base;
  return {
    freq: "weekly",
    interval: 1,
    byWeekday: ["MO"],
    times: ["09:00"],
    timezone,
    start,
    until: null,
    count: null,
  };
}
const zoneOf = (r: Routine | undefined) =>
  r && (r.trigger.type === "schedule" || r.trigger.type === "once") ? r.trigger.timezone || "UTC" : "";

/** The email trigger a routine has (new, or another kind: none picked yet, the inbox). */
const emailDraftOf = (r: Routine | undefined): EmailTriggerDraft =>
  r?.trigger.type === "email"
    ? { accountId: r.trigger.accountId, folder: r.trigger.folder, filter: r.trigger.filter ?? {} }
    : { accountId: "", folder: "", filter: {} };
const isUtc = (z: string) => z === "UTC" || z === "Etc/UTC";

/**
 * "Nova rotina" and "Editar" (the same form). Editing starts from the routine
 * and saves only what changed; a routine still read in UTC (made before time
 * zones) starts in my zone, with a hint to keep UTC instead.
 */
function RoutineDialog({
  open,
  onClose,
  routine,
  onWebhook,
}: {
  open: boolean;
  onClose: () => void;
  routine?: Routine;
  /** It just became a webhook routine (made, or switched to one): its address is on its page, which opens. */
  onWebhook?: (routine: Routine) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const channels = useChannels(org.id);
  const targetLabel = useTargetLabel();
  const action = useRoutineAction(org.id);
  const agents = actors.dir.agents;
  const editing = Boolean(routine);
  const initialForum = routine?.target.type === "forum" ? routine.target : null;
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "America/Sao_Paulo";
  const savedZone = zoneOf(routine);
  const wasUtc = editing && routine !== undefined && !isEventDriven(routine) && isUtc(savedZone);
  const [agentId, setAgentId] = useState(routine?.agentId ?? "");
  const [target, setTarget] = useState(targetChoice(routine?.target));
  // "Um tópico no fórum": which agents discuss, and how many rounds.
  const [forumAgents, setForumAgents] = useState<string[]>(initialForum?.agentIds ?? []);
  const [forumRounds, setForumRounds] = useState<(typeof FORUM_ROUNDS)[number]>(
    (FORUM_ROUNDS as readonly string[]).includes(String(initialForum?.rounds))
      ? (String(initialForum?.rounds) as (typeof FORUM_ROUNDS)[number])
      : "3",
  );
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [name, setName] = useState(routine?.name ?? "");
  const [kind, setKind] = useState<"schedule" | "event" | "email" | "webhook">(
    routine?.trigger.type === "event" || routine?.trigger.type === "email" || routine?.trigger.type === "webhook"
      ? routine.trigger.type
      : "schedule",
  );
  // "Quando chegar um email": the mailbox, folder and filters.
  const [email, setEmail] = useState<EmailTriggerDraft>(() => emailDraftOf(routine));
  const mailboxes = useMailAccounts(org.id);
  // "Quando chegar um email" shows where the organization has mailboxes (or the routine already uses one).
  const hasMail = kind === "email" || (mailboxes.data?.length ?? 0) > 0;
  // What the person typed, in any language: the server reads it (never the browser) and fills the picker.
  const [phrase, setPhrase] = useState(phraseOf(routine));
  const [event, setEvent] = useState<RoutineEvent>(
    routine?.trigger.type === "event" ? routine.trigger.event : "sentry.issue_created",
  );
  const [active, setActive] = useState(routine?.active ?? true);
  // When it posts.
  const [report, setReport] = useState<RoutineReport>(routine?.report ?? "when_new");
  const say = useSay();
  const [touched, setTouched] = useState(false);
  // One source of truth for "when": the rule (the picker), with the phrase kept in step.
  const [rule, setRule] = useState<RecurrenceRule>(() => ruleOf(routine, wasUtc ? myZone : savedZone || myZone));
  // What the routine had, to tell whether "when" changed.
  const [savedRule] = useState(() => JSON.stringify(toApiRule(ruleOf(routine, savedZone || myZone))));
  const zone = rule.timezone;
  // My zone may arrive after the form opens (the people list loads): follow it until a zone is picked.
  const [zoneTouched, setZoneTouched] = useState(false);
  const setZone = (z: string) => {
    setZoneTouched(true);
    setRule((r) => ({ ...r, timezone: z }));
  };
  const followsMyZone = !routine || wasUtc;
  useEffect(() => {
    if (followsMyZone && !zoneTouched) setRule((r) => (r.timezone === myZone ? r : { ...r, timezone: myZone }));
  }, [myZone, followsMyZone, zoneTouched]);
  // The phrase was typed (its parse fills the picker); picking in the picker clears it.
  const [phraseTyped, setPhraseTyped] = useState(false);
  const pickRule = (next: RecurrenceRule) => {
    setRule(next);
    setPhrase("");
    setPhraseTyped(false);
  };
  const typePhrase = (text: string) => {
    setPhrase(text);
    setPhraseTyped(true);
  };
  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);
  useEffect(() => {
    if (!target && channels.data?.[0]) setTarget(channels.data[0].id);
  }, [target, channels.data]);
  const typed = useDeferredValue(phrase.trim());
  const once = rule.freq === "once";
  const parsed = useRuleParse(org.id, typed, open && kind === "schedule" && phraseTyped && typed.length > 0, zone);
  // A phrase the server understood fills the picker (one source of truth: the rule).
  const parsedRule = parsed.data?.ok ? parsed.data.rule : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply each new parse once
  useEffect(() => {
    if (parsedRule && phraseTyped) setRule((r) => ({ ...fromApiRule(parsedRule, r.start), timezone: r.timezone }));
  }, [parsedRule]);
  const apiRule = kind === "schedule" && !once ? toApiRule(rule) : null;
  const described = useRuleDescribe(org.id, open ? apiRule : null);
  const info = described.data?.ok ? described.data : null;
  // The picker opens on demand ("Ajustar"); the sentence and next runs always show.
  const [pickerOpen, setPickerOpen] = useState(false);
  const upcoming = info?.nextRuns.length
    ? info.nextRuns.slice(0, 3).map((iso) => runLabel(i18n.language, iso, rule.timezone))
    : upcomingLabels(i18n.language, rule);
  const phraseFailed = phraseTyped && typed.length > 0 && parsed.data?.ok === false;
  const shownZone = zone;
  const scheduleOk =
    kind === "event" || kind === "webhook" || (kind === "email" ? Boolean(email.accountId) : once || !phraseFailed);
  const targetValue = (): RoutineTargetInput =>
    target === TARGET_FORUM
      ? { type: "forum", agentIds: forumAgents.length > 0 ? forumAgents : [agentId], rounds: Number(forumRounds) }
      : target === TARGET_DM
        ? { type: "dm" }
        : target === TARGET_ARTIFACT
          ? { type: "artifact" }
          : { type: "channel", channelId: target };
  const emailTrigger = () => ({
    type: "email" as const,
    accountId: email.accountId,
    folder: email.folder || INBOX,
    filter: cleanFilter(email.filter),
  });
  const trigger = (): RoutineInput["trigger"] =>
    kind === "webhook"
      ? { type: "webhook" }
      : kind === "email"
        ? emailTrigger()
        : kind === "event"
          ? { type: "event", event }
          : once
            ? {
                type: "once",
                at: zonedInstant(rule.start, rule.times[0] ?? "09:00", rule.timezone).toISOString(),
                timezone: rule.timezone,
              }
            : { type: "schedule", rule: toApiRule(rule) };
  /** What changed against the routine (`PATCH` sends only this). */
  const changes = (r: Routine): RoutinePatch => {
    const patch: RoutinePatch = {};
    if (name.trim() && name.trim() !== r.name) patch.name = name.trim();
    if (r.prompt !== null && prompt.trim() !== r.prompt) patch.prompt = prompt.trim();
    if (agentId !== r.agentId) patch.agentId = agentId;
    const forumChanged =
      target === TARGET_FORUM &&
      r.target.type === "forum" &&
      (JSON.stringify([...(forumAgents.length > 0 ? forumAgents : [agentId])].sort()) !==
        JSON.stringify([...r.target.agentIds].sort()) ||
        Number(forumRounds) !== (r.target.rounds ?? 3));
    if (target !== TARGET_KEEP && (target !== targetChoice(r.target) || forumChanged)) patch.target = targetValue();
    const triggerChanged =
      kind === "webhook"
        ? r.trigger.type !== "webhook"
        : kind === "email"
          ? r.trigger.type !== "email" ||
            JSON.stringify(emailTrigger()) !==
              JSON.stringify({
                type: "email",
                accountId: r.trigger.accountId,
                folder: r.trigger.folder,
                filter: cleanFilter(r.trigger.filter ?? {}),
              })
          : kind === "event"
            ? r.trigger.type !== "event" || r.trigger.event !== event
            : once
              ? r.trigger.type !== "once" ||
                JSON.stringify(trigger()) !== JSON.stringify({ type: "once", at: r.trigger.at, timezone: savedZone })
              : r.trigger.type !== "schedule" || JSON.stringify(toApiRule(rule)) !== savedRule;
    if (triggerChanged) patch.trigger = trigger();
    if (active !== r.active) patch.active = active;
    if (report !== r.report) patch.report = report;
    return patch;
  };
  // A routine on someone's computer that runs hourly or more often: say how often it wakes that computer.
  const brain = actors.dir.agentById.get(agentId)?.brain;
  const selfHost = useComputerEdition(org.id) === "selfhost";
  const namesComputer = useNamesComputers(org.id);
  const busy =
    kind === "schedule" && !once && brain
      ? busyOnComputer({ kind: brain.kind, machineName: brain.computer ?? null }, runsPerDay(toApiRule(rule)), {
          selfHost,
          namesComputer,
        })
      : null;
  // Only a phrase that wasn't understood says something here; the sentence above already says what was.
  const phraseError = () => {
    if (phraseFailed && parsed.data && !parsed.data.ok) {
      const tt = t as unknown as (k: string, o: Record<string, unknown>) => string;
      const code = parsed.data.code;
      return code
        ? tt(`routines.form.parseError.${code.replace(/\./g, "_")}`, { defaultValue: parsed.data.error })
        : parsed.data.error;
    }
    return undefined;
  };
  /** A starting point: what to do, a name and when (the phrase is read by the server, like a typed one). */
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setPrompt(t(`routines.presets.${p.key}.prompt`));
    setName(t(`routines.presets.${p.key}.name`));
    setKind(p.kind);
    if (p.kind === "event") setEvent(p.event);
    else typePhrase(t(`routines.presets.${p.key}.phrase`));
  };
  const becameWebhook = (saved: Routine | undefined) => {
    if (saved?.trigger.type === "webhook") onWebhook?.(saved);
  };
  const submit = () => {
    setTouched(true);
    if (!prompt.trim() || !agentId || !scheduleOk) return;
    if (routine) {
      const patch = changes(routine);
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      action.mutate(
        { type: "update", id: routine.id, patch },
        {
          onSuccess: (saved) => {
            const next = (saved as Routine | undefined)?.nextRunAt;
            toast.show(
              next
                ? t("routines.form.saved", { next: t("routines.next", { when: nextLabel(i18n.language, next) }) })
                : t("routines.form.savedNoNext"),
            );
            onClose();
            if (routine.trigger.type !== "webhook") becameWebhook(saved as Routine);
          },
        },
      );
      return;
    }
    action.mutate(
      {
        type: "create",
        input: {
          name: name.trim() || undefined,
          agentId,
          prompt: prompt.trim(),
          target: targetValue(),
          trigger: trigger(),
          report,
        },
      },
      {
        onSuccess: (created) => {
          toast.show(t("routines.form.created"));
          setPrompt("");
          setName("");
          setTouched(false);
          onClose();
          becameWebhook(created as Routine);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? t("routines.editTitle") : t("routines.new")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogBody>
          {agents.length === 0 && <p className="small muted">{t("routines.form.noAgents")}</p>}
          {!editing && !prompt.trim() && (
            <fieldset className="routine-presets">
              <legend className="ac-eyebrow">{t("routines.presets.title")}</legend>
              <div className="routine-presets__list">
                {PRESETS.map((p) => (
                  <button key={p.key} type="button" className="routine-preset" onClick={() => applyPreset(p)}>
                    <span className="routine-preset__icon" aria-hidden="true">
                      <Icon name={p.icon} size={16} />
                    </span>
                    <span>
                      <b>{t(`routines.presets.${p.key}.name`)}</b>
                      <small>{t(`routines.presets.${p.key}.text`)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="grid-fields">
            <Field label={t("routines.form.agent")} id="nr-agent">
              <Select
                value={agentId || undefined}
                onValueChange={setAgentId}
                options={agents.map((a) => ({
                  value: a.id,
                  label: a.name,
                  description: a.role || undefined,
                  leading: actors.avatar({ type: "agent", id: a.id }),
                }))}
              />
            </Field>
            <Field label={t("routines.form.target")} id="nr-target">
              <Select
                value={target || undefined}
                onValueChange={setTarget}
                options={[
                  ...(routine && target === TARGET_KEEP
                    ? [{ value: TARGET_KEEP, label: targetLabel(routine.target) }]
                    : []),
                  ...(channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` })),
                  { value: TARGET_DM, label: t("routines.target.dm") },
                  { value: TARGET_ARTIFACT, label: t("routines.target.artifact") },
                  { value: TARGET_FORUM, label: t("routines.target.forum") },
                ]}
              />
            </Field>
          </div>
          {target === TARGET_FORUM && (
            <div className="routine-forum">
              <span className="ac-field__label">{t("routines.form.forumAgents")}</span>
              {agents.map((a) => {
                const id = `nr-fa-${a.id}`;
                return (
                  <label key={a.id} htmlFor={id} className="scope-row">
                    <Checkbox
                      id={id}
                      aria-label={a.name}
                      checked={forumAgents.includes(a.id) || (forumAgents.length === 0 && a.id === agentId)}
                      onCheckedChange={(on) =>
                        setForumAgents((l) => {
                          const base = l.length === 0 ? [agentId] : l;
                          return on ? [...new Set([...base, a.id])] : base.filter((x) => x !== a.id);
                        })
                      }
                    />
                    <span className="scope-row__text" aria-hidden="true">
                      <span className="ac-iconline">
                        {actors.avatar({ type: "agent", id: a.id })}
                        <span>{a.name}</span>
                      </span>
                    </span>
                  </label>
                );
              })}
              <span className="ac-field__label">{t("forum.form.rounds")}</span>
              <Segmented
                label={t("forum.form.rounds")}
                value={forumRounds}
                onValueChange={setForumRounds}
                options={FORUM_ROUNDS.map((r) => ({ value: r, label: r }))}
              />
            </div>
          )}
          <Field
            label={t("routines.form.what")}
            id="nr-what"
            error={touched && !prompt.trim() ? t("routines.form.required") : undefined}
          >
            <Textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("routines.form.whatPlaceholder")}
            />
          </Field>
          <Field label={editing ? t("routines.form.title") : t("routines.form.name")} id="nr-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="routine-kind">
            <span className="ac-field__label">{t("routines.form.when")}</span>
            <Segmented
              label={t("routines.form.when")}
              value={kind}
              onValueChange={setKind}
              options={[
                { value: "schedule" as const, label: t("routines.form.kind.schedule") },
                { value: "event" as const, label: t("routines.form.kind.event") },
                ...(hasMail ? [{ value: "email" as const, label: t("routines.form.kind.email") }] : []),
                { value: "webhook" as const, label: t("routines.form.kind.webhook") },
              ]}
            />
          </div>
          {kind === "email" && <EmailTriggerFields value={email} onChange={setEmail} />}
          {kind === "webhook" &&
            (routine?.trigger.type === "webhook" ? (
              <WebhookPanel routine={routine} runs={routine.recentRuns} />
            ) : (
              <p className="routine-note small ac-iconline">
                <Icon name="link" size={14} />
                <span>{t("routines.webhook.newNote")}</span>
              </p>
            ))}
          {kind === "schedule" && (
            <div className="routine-when">
              <div className="routine-when__head">
                <span className="routine-when__sentence" aria-live="polite">
                  {ruleSentence(t, i18n.language, rule, new Date(), false)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  icon="repeat"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((o) => !o)}
                >
                  {t("routines.form.adjust")}
                </Button>
              </div>
              {!pickerOpen && upcoming.length > 0 && (
                <div className="ac-recur__upcoming">
                  <span className="ac-recur__label">{t("routines.form.next")}</span>
                  <ol>
                    {upcoming.map((label) => (
                      <li key={label} className="tabular">
                        {label}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {pickerOpen && (
                <RecurrencePicker
                  value={rule}
                  onChange={pickRule}
                  labels={recurrenceLabels(t, i18n.language, rule)}
                  locale={i18n.language}
                  upcoming={upcoming}
                  hideTimezone
                />
              )}
            </div>
          )}
          {kind === "schedule" && (
            <>
              {!once && (
                <Field label={t("routines.form.frequency")} id="nr-when" error={phraseError()}>
                  <Input
                    value={phrase}
                    onChange={(e) => typePhrase(e.target.value)}
                    placeholder={t("recurrence.phrasePlaceholder")}
                  />
                </Field>
              )}
              <Field label={t("routines.form.timezone")} id="nr-zone">
                <ZoneSelect value={zone} onChange={setZone} />
              </Field>
            </>
          )}
          {kind === "schedule" && wasUtc && !isUtc(shownZone) && (
            <p className="routine-utc-hint small ac-iconline">
              <Icon name="waiting" size={14} />
              <span>{t("routines.form.utcHint", { zone: timezoneName(shownZone, i18n.language) })}</span>
              <button type="button" className="ac-link" onClick={() => setZone("UTC")}>
                {t("routines.form.keepUtc")}
              </button>
            </p>
          )}
          {kind !== "event" ? null : (
            <Field
              label={t("routines.form.event")}
              id="nr-event"
              hint={{
                name: t("common.about", { label: t("routines.form.event") }),
                text: t("routines.form.eventHelp", { org: org.name }),
              }}
            >
              <Select
                value={event}
                onValueChange={(v) => setEvent(v as RoutineEvent)}
                options={ROUTINE_EVENTS.map((e) => ({ value: e, label: t(`routines.event.${e}`) }))}
              />
            </Field>
          )}
          {busy && (
            <p className="routine-note small ac-iconline" role="status">
              <Icon name="computer" size={14} />
              <span>{say(busy)}</span>
            </p>
          )}
          <div className="routine-kind">
            <span className="ac-hintline">
              <span className="ac-field__label">{t("routines.form.report")}</span>
              <InfoHint name={t("common.about", { label: t("routines.form.report") })}>
                {t("routines.report.hint")}
              </InfoHint>
            </span>
            <Segmented
              label={t("routines.form.report")}
              value={report}
              onValueChange={setReport}
              options={(["always", "when_new"] as const).map((v) => ({ value: v, label: t(`routines.report.${v}`) }))}
            />
          </div>
          <RoutineReachWarnings prompt={prompt} agentId={agentId || null} creatorUserId={routine?.createdByUserId} />
          {editing && !(routine && isDoneOnce(routine)) && (
            <label className="routine-active" htmlFor="nr-active">
              <Switch id="nr-active" checked={active} onCheckedChange={setActive} />
              <span>{t("routines.form.active")}</span>
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("routines.form.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending || !agentId || !scheduleOk}>
            {editing ? t("routines.form.save") : t("routines.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A one-off routine's moment as a rule ("Uma vez", that day and time in its zone). */
function onceRule(at: string, timezone: string): RecurrenceRule {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    freq: "once",
    interval: 1,
    times: [`${get("hour")}:${get("minute")}`],
    timezone,
    start: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** A next run ("seg, 20 out · 09:00") in the rule's zone. */
function runLabel(locale: string, iso: string, timeZone: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
  return `${date} · ${time}`;
}
