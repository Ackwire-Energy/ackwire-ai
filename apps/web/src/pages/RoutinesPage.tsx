import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  List,
  RadioCard,
  RadioGroup,
  Select,
  Textarea,
} from "@agenteschat/ui";
import { useDeferredValue, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannels, useRoutineAction, useRoutineRuns, useRoutines, useScheduleParse } from "@/api/queries";
import type { Routine, RoutineEvent, RoutineTarget } from "@/api/types";
import { useActors } from "@/components/actors";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { formatUsd, whenAt } from "@/lib/format";
import { COMMON_TIMEZONES, timezoneLabel } from "@/lib/routines";
import { useToast } from "@/lib/toast";

export const ROUTINE_EVENTS: RoutineEvent[] = [
  "sentry.issue_created",
  "github.pr_opened",
  "issue.created",
  "deploy.succeeded",
];

/** Weekday + time, "seg 20 out, 09:00". */
const nextLabel = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(/\./g, "")
    .replace(/ de /g, " ");

function useTargetLabel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  return (target: RoutineTarget) => {
    if (target.type === "channel") {
      const c = channels.data?.find((x) => x.id === target.channelId);
      return c ? `#${c.name}` : "#";
    }
    return t(target.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
}

/** Rotinas (telas/Rotinas.dc.html): scheduled and event-driven agent tasks. */
export function RoutinesPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const routines = useRoutines(org.id);
  const [creating, setCreating] = useState(false);
  const [runsFor, setRunsFor] = useState<Routine | null>(null);
  const list = routines.data ?? [];
  return (
    <div className="page page--mid">
      <header
        className="page__header page__header--row"
        style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}
      >
        <div className="stack-4" style={{ flex: "1 1 320px", gap: 4 }}>
          <h1 className="page-title">{t("routines.title")}</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            {t("routines.subtitle")}
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          {t("routines.new")}
        </Button>
      </header>
      {routines.isLoading && <LoadingCards count={3} />}
      {routines.isError && !routines.data && (
        <ErrorState error={routines.error} onRetry={() => void routines.refetch()} />
      )}
      {routines.isSuccess && list.length === 0 && <EmptyState icon="routines">{t("routines.empty")}</EmptyState>}
      <div className="stack-4" style={{ gap: 12 }}>
        {list.map((r) => (
          <RoutineCard key={r.id} routine={r} onRuns={() => setRunsFor(r)} />
        ))}
      </div>
      <NewRoutineDialog open={creating} onClose={() => setCreating(false)} />
      <RunsDialog routine={runsFor} onClose={() => setRunsFor(null)} />
    </div>
  );
}

function RoutineCard({ routine: r, onRuns }: { routine: Routine; onRuns: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useRoutineAction(org.id);
  const target = useTargetLabel();
  const agent = { type: "agent" as const, id: r.agentId };
  // The zone always shows, so a routine read in UTC by mistake is easy to spot.
  const when =
    r.trigger.type === "schedule"
      ? `${r.trigger.description} (${timezoneLabel(r.trigger.timezone || "UTC")})`
      : t(`routines.event.${r.trigger.event}`);
  const next = !r.active
    ? t("routines.paused")
    : r.trigger.type === "event"
      ? t("routines.waitingEvent")
      : r.nextRunAt
        ? t("routines.next", { when: nextLabel(i18n.language, r.nextRunAt) })
        : "";
  return (
    <article className="routine-card" aria-label={r.name} data-active={r.active || undefined}>
      <div className="routine-card__head">
        {actors.avatar(agent, "sm")}
        <div className="list-col" style={{ flex: "1 1 200px" }}>
          <span className="routine-card__name">{r.name}</span>
          <span className="small muted">
            {t("routines.deliversTo", { agent: actors.name(agent), target: target(r.target) })}
          </span>
        </div>
        <Chip icon={r.trigger.type === "event" ? "bolt" : "waiting"}>{when}</Chip>
        <span className="row" style={{ gap: 6, alignItems: "center" }}>
          <Checkbox
            id={`rt-${r.id}`}
            checked={r.active}
            aria-label={t("routines.activeLabel", { name: r.name })}
            onCheckedChange={(v) => action.mutate({ type: "active", id: r.id, active: v })}
          />
          <label htmlFor={`rt-${r.id}`} aria-hidden="true">
            {t("routines.active")}
          </label>
        </span>
      </div>
      <div className="routine-card__foot small muted">
        <span>{next}</span>
        <span>
          {r.lastRun
            ? t("routines.last", { when: whenAt(t, i18n.language, r.lastRun.at), summary: r.lastRun.summary })
            : t("routines.never")}
        </span>
        <span className="tabular">{t("routines.cost", { amount: formatUsd(t, i18n.language, r.monthCostUsd) })}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="ghost"
          disabled={r.running || action.isPending}
          loading={action.isPending}
          onClick={() => action.mutate({ type: "run", id: r.id })}
        >
          {r.running ? t("routines.running") : t("routines.runNow")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRuns}>
          {t("routines.runs")}
        </Button>
      </div>
    </article>
  );
}

function RunsDialog({ routine, onClose }: { routine: Routine | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const runs = useRoutineRuns(org.id, routine?.id ?? null);
  return (
    <Dialog
      open={Boolean(routine)}
      onOpenChange={(o) => !o && onClose()}
      title={t("routines.runsTitle", { name: routine?.name ?? "" })}
      closeLabel={t("routines.close")}
    >
      <div className="ac-dialog__list">
        {runs.isLoading && <LoadingList count={3} avatar={false} />}
        {runs.isSuccess && runs.data.length === 0 && <p className="small muted">{t("routines.noRuns")}</p>}
        <List>
          {(runs.data ?? []).map((x) => (
            <div key={x.id} className="ac-list__row">
              <span className="small muted tabular" style={{ flex: "0 0 96px" }}>
                {whenAt(t, i18n.language, x.at)}
              </span>
              <span style={{ flex: 1 }}>{x.summary}</span>
              <Chip icon={x.status === "ok" ? "check" : "alert"}>{t(`routines.runStatus.${x.status}`)}</Chip>
              <span className="small muted tabular">{formatUsd(t, i18n.language, x.costUsd)}</span>
            </div>
          ))}
        </List>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>{t("routines.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

const TARGET_DM = "dm";
const TARGET_ARTIFACT = "artifact";

function NewRoutineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const channels = useChannels(org.id);
  const action = useRoutineAction(org.id);
  const agents = actors.dir.agents;
  const [agentId, setAgentId] = useState("");
  const [target, setTarget] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"schedule" | "event">("schedule");
  const [phrase, setPhrase] = useState("toda segunda às 9h");
  const [event, setEvent] = useState<RoutineEvent>("sentry.issue_created");
  const [touched, setTouched] = useState(false);
  /** Empty = let the server read it in the person's own zone; set once they pick one. */
  const [zone, setZone] = useState("");
  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);
  useEffect(() => {
    if (!target && channels.data?.[0]) setTarget(channels.data[0].id);
  }, [target, channels.data]);
  const typed = useDeferredValue(phrase.trim());
  const parsed = useScheduleParse(org.id, typed, open && kind === "schedule" && typed.length > 0, zone || undefined);
  const shownZone = zone || (parsed.data?.ok ? parsed.data.timezone : "");
  const zoneOptions = [...new Set([...(shownZone ? [shownZone] : []), ...COMMON_TIMEZONES])].map((z) => ({
    value: z,
    label: timezoneLabel(z),
  }));
  const scheduleOk = kind === "event" || (typed.length > 0 && parsed.data?.ok === true);
  const targetValue = (): RoutineTarget =>
    target === TARGET_DM
      ? { type: "dm" }
      : target === TARGET_ARTIFACT
        ? { type: "artifact" }
        : { type: "channel", channelId: target };
  const help = () => {
    if (!typed) return t("routines.form.frequencyPlaceholder");
    if (!parsed.data) return "";
    return parsed.data.ok
      ? t("routines.form.parsed", {
          description: parsed.data.description,
          timezone: timezoneLabel(parsed.data.timezone),
        })
      : parsed.data.error;
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("routines.new")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!prompt.trim() || !agentId || !scheduleOk) return;
          action.mutate(
            {
              type: "create",
              input: {
                name: name.trim() || undefined,
                agentId,
                prompt: prompt.trim(),
                target: targetValue(),
                trigger: kind === "schedule" ? scheduleTrigger(phrase.trim(), shownZone) : { type: "event", event },
              },
            },
            {
              onSuccess: () => {
                toast.show(t("routines.form.created"));
                setPrompt("");
                setName("");
                setTouched(false);
                onClose();
              },
            },
          );
        }}
      >
        <DialogBody>
          {agents.length === 0 && <p className="small muted">{t("routines.form.noAgents")}</p>}
          <div className="grid-fields">
            <Field label={t("routines.form.agent")} id="nr-agent">
              <Select
                value={agentId || undefined}
                onValueChange={setAgentId}
                options={agents.map((a) => ({ value: a.id, label: a.name, description: a.role || undefined }))}
              />
            </Field>
            <Field label={t("routines.form.target")} id="nr-target">
              <Select
                value={target || undefined}
                onValueChange={setTarget}
                options={[
                  ...(channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` })),
                  { value: TARGET_DM, label: t("routines.target.dm") },
                  { value: TARGET_ARTIFACT, label: t("routines.target.artifact") },
                ]}
              />
            </Field>
          </div>
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
          <Field label={t("routines.form.name")} id="nr-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <RadioGroup
            value={kind}
            onValueChange={(v) => setKind(v as "schedule" | "event")}
            aria-label={t("routines.form.when")}
            className="grid-fields"
          >
            <RadioCard value="schedule" id="nr-k-time" checked={kind === "schedule"} title={t("routines.form.time")} />
            <RadioCard value="event" id="nr-k-event" checked={kind === "event"} title={t("routines.form.onEvent")} />
          </RadioGroup>
          {kind === "schedule" ? (
            <Field
              label={t("routines.form.frequency")}
              id="nr-when"
              help={parsed.data?.ok === false && typed ? undefined : help()}
              error={parsed.data?.ok === false && typed ? help() : undefined}
            >
              <Input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder={t("routines.form.frequencyPlaceholder")}
              />
            </Field>
          ) : null}
          {kind === "schedule" && shownZone ? (
            <Field label={t("routines.form.timezone")} id="nr-zone">
              <Select value={shownZone} onValueChange={setZone} options={zoneOptions} />
            </Field>
          ) : null}
          {kind === "schedule" ? null : (
            <Field
              label={t("routines.form.event")}
              id="nr-event"
              help={t("routines.form.eventHelp", { org: org.name })}
            >
              <Select
                value={event}
                onValueChange={(v) => setEvent(v as RoutineEvent)}
                options={ROUTINE_EVENTS.map((e) => ({ value: e, label: t(`routines.event.${e}`) }))}
              />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("routines.form.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending || !agentId || !scheduleOk}>
            {t("routines.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** The schedule trigger with the zone the person saw in the preview (the server reads the phrase in it). */
function scheduleTrigger(phrase: string, timezone: string) {
  const trigger = { type: "schedule" as const, phrase, ...(timezone ? { timezone } : {}) };
  return trigger as { type: "schedule"; phrase: string };
}
