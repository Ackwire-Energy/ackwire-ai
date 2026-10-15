import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FilterBar,
  FilterChip,
  Icon,
  Input,
  List,
  Menu,
  MenuItem,
  RadioCard,
  RadioGroup,
  RecurrencePicker,
  type RecurrenceRule,
  Segmented,
  Select,
  Switch,
  Textarea,
  zonedInstant,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useDeferredValue, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useChannels,
  useDms,
  useRoutineAction,
  useRoutineRuns,
  useRoutines,
  useRuleDescribe,
  useRuleParse,
} from "@/api/queries";
import type {
  Routine,
  RoutineEvent,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RoutineTarget,
  RoutineTargetInput,
} from "@/api/types";
import { useActors } from "@/components/actors";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { formatUsd, toYmd, whenAt } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import {
  defaultRule,
  fromApiRule,
  phraseToRule,
  recurrenceLabels,
  ruleSentence,
  ruleToPhrase,
  toApiRule,
  upcomingLabels,
} from "@/lib/recurrence";
import { browserTimezone, onceParts, timezoneLabel, timezoneName } from "@/lib/routines";
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

/** A one-off that already fired (or was cancelled): shown muted, under "Concluídos". */
export const isDoneOnce = (r: Routine) => r.trigger.type === "once" && !r.active;

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

/** Rotinas (telas/Rotinas.dc.html): scheduled and event-driven agent tasks. */
export function RoutinesPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const routines = useRoutines(org.id);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [runsFor, setRunsFor] = useState<Routine | null>(null);
  const [showDone, setShowDone] = useState(false);
  const list = routines.data ?? [];
  const [agents, setAgents] = useState<string[]>([]);
  const copy = useFilterCopy();
  const agentOptions = useActorFilterOptions().filter((o) => o.value.startsWith("agent:"));
  const byAgent = (r: Routine) => agents.length === 0 || agents.includes(`agent:${r.agentId}`);
  const current = list.filter((r) => !isDoneOnce(r) && byAgent(r));
  const done = list.filter((r) => isDoneOnce(r) && byAgent(r));
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
      {list.length > 0 && (
        <FilterBar
          label={t("routines.filters")}
          clearText={copy.clearAll}
          onClear={() => setAgents([])}
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
      )}
      {routines.isLoading && <LoadingCards count={3} />}
      {routines.isError && !routines.data && (
        <ErrorState error={routines.error} onRetry={() => void routines.refetch()} />
      )}
      {routines.isSuccess && list.length === 0 && (
        <EmptyState sky icon="routines">
          {t("routines.empty")}
        </EmptyState>
      )}
      <div className="stack-4" style={{ gap: 12 }}>
        {current.map((r) => (
          <RoutineCard key={r.id} routine={r} onRuns={() => setRunsFor(r)} onEdit={() => setEditing(r)} />
        ))}
      </div>
      {done.length > 0 && (
        <section className="routines-done" aria-label={t("routines.done")}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showDone}
            aria-controls="routines-done-list"
            onClick={() => setShowDone((v) => !v)}
          >
            {t("routines.doneToggle", { count: done.length })}
          </Button>
          {showDone && (
            <div id="routines-done-list" className="stack-4" style={{ gap: 12 }}>
              {done.map((r) => (
                <RoutineCard key={r.id} routine={r} onRuns={() => setRunsFor(r)} onEdit={() => setEditing(r)} />
              ))}
            </div>
          )}
        </section>
      )}
      <RoutineDialog open={creating} onClose={() => setCreating(false)} />
      <RoutineDialog
        key={editing?.id ?? "none"}
        open={Boolean(editing)}
        routine={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
      <RunsDialog routine={runsFor} onClose={() => setRunsFor(null)} />
    </div>
  );
}

/** A title for the card: a routine made from a chat message may be named with its whole prompt. */
export function routineTitle(r: Pick<Routine, "name" | "prompt">) {
  const name = r.name.trim();
  if (name !== r.prompt.trim() && name.length <= 80) return name;
  const first = (name.split("\n")[0] ?? name).trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

function RoutineCard({ routine: r, onRuns, onEdit }: { routine: Routine; onRuns: () => void; onEdit: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const actors = useActors();
  const toast = useToast();
  const action = useRoutineAction(org.id);
  const [deleting, setDeleting] = useState(false);
  const target = useTargetLabel();
  const agent = { type: "agent" as const, id: r.agentId };
  const title = routineTitle(r);
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "UTC";
  const zone = r.trigger.type === "event" ? "" : r.trigger.timezone || "UTC";
  // The zone shows only when it isn't mine ("(UTC)" for a routine still read in UTC).
  const zoneNote = zone && zone !== myZone ? ` (${timezoneName(zone, i18n.language)})` : "";
  const when =
    r.trigger.type === "schedule"
      ? `${
          r.trigger.rule
            ? ruleSentence(t, i18n.language, fromApiRule(r.trigger.rule, toYmd(new Date())), new Date(), false)
            : r.trigger.description
        }${zoneNote}`
      : r.trigger.type === "once"
        ? t("routines.once", { ...onceParts(i18n.language, r.trigger.at, zone), zone: zoneNote })
        : t(`routines.event.${r.trigger.event}`);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const done = isDoneOnce(r);
  const paused = !done && !r.active;
  const next = done
    ? null
    : !r.active
      ? null
      : r.trigger.type === "event"
        ? t("routines.waitingEvent")
        : r.nextRunAt
          ? t("routines.next", { when: nextLabel(i18n.language, r.nextRunAt) })
          : null;
  const more = t("routines.more", { name: title });
  return (
    <article
      className="routine-card"
      aria-label={title}
      data-active={r.active || undefined}
      data-paused={paused || undefined}
      data-done={done || undefined}
    >
      <div className="routine-card__head">
        {actors.avatar(agent, "sm")}
        <div className="routine-card__main">
          <span className="routine-card__name" title={r.name}>
            {title}
          </span>
          <span className="small muted">
            {r.target.type === "conversation"
              ? t("routines.deliversIn", { agent: actors.name(agent), place: target(r.target) })
              : t("routines.deliversTo", { agent: actors.name(agent), target: target(r.target) })}
          </span>
        </div>
        <div className="routine-card__aside">
          <div className="routine-card__chips">
            {reminder && <Chip icon="bell">{t("routines.reminder")}</Chip>}
            <Chip icon={r.trigger.type === "event" ? "bolt" : "waiting"}>{when}</Chip>
            {done ? (
              <Chip icon="check">{r.lastRun ? t("routines.fired") : t("routines.canceled")}</Chip>
            ) : (
              <Chip icon={r.active ? "play" : "pause"}>{r.active ? t("routines.active") : t("routines.paused")}</Chip>
            )}
          </div>
          <div className="routine-card__actions">
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              onClick={onEdit}
              aria-label={t("routines.editName", { name: title })}
            >
              {t("routines.edit")}
            </Button>
            {!done && !reminder && (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={r.running ? "spinner" : "play"}
                title={r.running ? t("routines.running") : t("routines.runNow")}
                aria-label={r.running ? t("routines.running") : t("routines.runNow")}
                disabled={r.running || action.isPending}
                onClick={() => action.mutate({ type: "run", id: r.id })}
              />
            )}
            <Menu
              align="end"
              label={more}
              trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={more} />}
            >
              {paused && (
                <MenuItem icon="play" onSelect={() => action.mutate({ type: "active", id: r.id, active: true })}>
                  {t("routines.resume")}
                </MenuItem>
              )}
              <MenuItem icon="waiting" onSelect={onRuns}>
                {t("routines.runs")}
              </MenuItem>
              <MenuItem
                icon="copy"
                onSelect={() =>
                  action.mutate(
                    { type: "duplicate", id: r.id },
                    {
                      onSuccess: (copy) =>
                        toast.show(t("routines.duplicated", { name: (copy as Routine | undefined)?.name ?? r.name })),
                    },
                  )
                }
              >
                {t("routines.duplicate")}
              </MenuItem>
              {r.webhookUrl && (
                <MenuItem
                  icon="link"
                  onSelect={async () => {
                    await navigator.clipboard?.writeText(r.webhookUrl ?? "");
                    toast.show(t("routines.webhookCopied"));
                  }}
                >
                  {t("routines.copyWebhook")}
                </MenuItem>
              )}
              <MenuItem icon="trash" onSelect={() => setDeleting(true)}>
                {t("routines.delete")}
              </MenuItem>
            </Menu>
          </div>
        </div>
      </div>
      <p className="routine-card__foot">
        <span>
          {r.lastRun
            ? t("routines.last", { when: whenAt(t, i18n.language, r.lastRun.at), summary: runSummary(t, r.lastRun) })
            : t("routines.never")}
        </span>
        {next && <span>{next}</span>}
        <span className="tabular">{t("routines.cost", { amount: formatUsd(t, i18n.language, r.monthCostUsd) })}</span>
      </p>
      <Dialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title={t("routines.deleteTitle", { name: title })}
        description={t("routines.deleteBody")}
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
              <span style={{ flex: 1 }}>{runSummary(t, x)}</span>
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

/** The phrase the routine was set with ("toda segunda às 9h"; made with the picker: its rule's phrase). */
function phraseOf(r: Routine | undefined): string {
  if (!r) return "toda segunda às 9h";
  if (r.trigger.type === "schedule") {
    if (r.trigger.phrase) return r.trigger.phrase;
    if (r.trigger.rule) return ruleToPhrase(fromApiRule(r.trigger.rule, toYmd(new Date())));
    return r.trigger.description;
  }
  return r.trigger.type === "once" ? r.trigger.description : "toda segunda às 9h";
}

/** The rule a routine runs on, in `zone` (a phrase-only routine: its phrase read as a rule). */
function ruleOf(r: Routine | undefined, zone: string): RecurrenceRule {
  const base = defaultRule(zone);
  if (r?.trigger.type === "once") return onceRule(r.trigger.at, zone);
  if (r?.trigger.type === "schedule" && r.trigger.rule)
    return { ...fromApiRule(r.trigger.rule, base.start), timezone: zone };
  return phraseToRule(phraseOf(r), base) ?? base;
}
const zoneOf = (r: Routine | undefined) => (r && r.trigger.type !== "event" ? r.trigger.timezone || "UTC" : "");
const isUtc = (z: string) => z === "UTC" || z === "Etc/UTC";

/**
 * "Nova rotina" and "Editar" (the same form). Editing starts from the routine
 * and saves only what changed; a routine still read in UTC (made before time
 * zones) starts in my zone, with a hint to keep UTC instead.
 */
function RoutineDialog({ open, onClose, routine }: { open: boolean; onClose: () => void; routine?: Routine }) {
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
  const wasUtc = editing && routine?.trigger.type !== "event" && isUtc(savedZone);
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
  const [kind, setKind] = useState<"schedule" | "event">(routine?.trigger.type === "event" ? "event" : "schedule");
  // The phrase field speaks Portuguese (the parser's language); in another UI language it starts empty.
  const phraseLang = i18n.language.startsWith("pt");
  const [phrase, setPhrase] = useState(routine || phraseLang ? phraseOf(routine) : "");
  const [event, setEvent] = useState<RoutineEvent>(
    routine?.trigger.type === "event" ? routine.trigger.event : "sentry.issue_created",
  );
  const [budget, setBudget] = useState(routine?.budgetUsd ? String(routine.budgetUsd) : "");
  const [active, setActive] = useState(routine?.active ?? true);
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
  // The phrase was typed (its parse fills the picker) or follows the picker.
  const [phraseTyped, setPhraseTyped] = useState(false);
  const pickRule = (next: RecurrenceRule) => {
    setRule(next);
    setPhrase(phraseLang ? ruleToPhrase(next) : "");
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
  // The picker opens on demand ("Ajustar dias e horários"); the sentence and next runs always show.
  const [pickerOpen, setPickerOpen] = useState(false);
  const upcoming = info?.nextRuns.length
    ? info.nextRuns.slice(0, 3).map((iso) => runLabel(i18n.language, iso, rule.timezone))
    : upcomingLabels(i18n.language, rule);
  const phraseFailed = phraseTyped && typed.length > 0 && parsed.data?.ok === false;
  const shownZone = zone;
  const scheduleOk = kind === "event" || once || !phraseFailed;
  const budgetValue = budget.trim() ? Number(budget.replace(",", ".")) : null;
  const budgetOk = budgetValue === null || (Number.isFinite(budgetValue) && budgetValue > 0);
  const targetValue = (): RoutineTargetInput =>
    target === TARGET_FORUM
      ? { type: "forum", agentIds: forumAgents.length > 0 ? forumAgents : [agentId], rounds: Number(forumRounds) }
      : target === TARGET_DM
        ? { type: "dm" }
        : target === TARGET_ARTIFACT
          ? { type: "artifact" }
          : { type: "channel", channelId: target };
  const trigger = (): RoutineInput["trigger"] =>
    kind === "event"
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
    if (prompt.trim() !== r.prompt) patch.prompt = prompt.trim();
    if (agentId !== r.agentId) patch.agentId = agentId;
    const forumChanged =
      target === TARGET_FORUM &&
      r.target.type === "forum" &&
      (JSON.stringify([...(forumAgents.length > 0 ? forumAgents : [agentId])].sort()) !==
        JSON.stringify([...r.target.agentIds].sort()) ||
        Number(forumRounds) !== (r.target.rounds ?? 3));
    if (target !== TARGET_KEEP && (target !== targetChoice(r.target) || forumChanged)) patch.target = targetValue();
    const triggerChanged =
      kind === "event"
        ? r.trigger.type !== "event" || r.trigger.event !== event
        : once
          ? r.trigger.type !== "once" ||
            JSON.stringify(trigger()) !== JSON.stringify({ type: "once", at: r.trigger.at, timezone: savedZone })
          : r.trigger.type !== "schedule" || JSON.stringify(toApiRule(rule)) !== savedRule;
    if (triggerChanged) patch.trigger = trigger();
    if (budgetValue !== (r.budgetUsd ?? null)) patch.budgetUsd = budgetValue;
    if (active !== r.active) patch.active = active;
    return patch;
  };
  const help = () => {
    if (phraseFailed && parsed.data && !parsed.data.ok) return parsed.data.error;
    if (!info) return "";
    return t("routines.form.parsed", {
      description: info.description,
      timezone: timezoneLabel(rule.timezone, undefined, i18n.language),
    });
  };
  const submit = () => {
    setTouched(true);
    if (!prompt.trim() || !agentId || !scheduleOk || !budgetOk) return;
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
          ...(budgetValue !== null ? { budgetUsd: budgetValue } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.show(t("routines.form.created"));
          setPrompt("");
          setName("");
          setBudget("");
          setTouched(false);
          onClose();
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
                      <span>{a.name}</span>
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
          <RadioGroup
            value={kind}
            onValueChange={(v) => setKind(v as "schedule" | "event")}
            aria-label={t("routines.form.when")}
            className="grid-fields"
          >
            <RadioCard value="schedule" id="nr-k-time" checked={kind === "schedule"} title={t("routines.form.time")} />
            <RadioCard value="event" id="nr-k-event" checked={kind === "event"} title={t("routines.form.onEvent")} />
          </RadioGroup>
          {kind === "schedule" && (
            <div className="routine-when">
              <div className="routine-when__head">
                <span className="routine-when__sentence" aria-live="polite">
                  {ruleSentence(t, i18n.language, rule)}
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
                <span className="small muted">{t("routines.form.nextRuns", { list: upcoming.join(" · ") })}</span>
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
            <Field label={t("routines.form.timezone")} id="nr-zone">
              <ZoneSelect value={zone} onChange={setZone} />
            </Field>
          )}
          {kind === "schedule" && !once ? (
            <Field
              label={t("routines.form.frequency")}
              id="nr-when"
              help={phraseFailed ? undefined : help()}
              error={phraseFailed ? help() : undefined}
            >
              <Input
                value={phrase}
                onChange={(e) => typePhrase(e.target.value)}
                placeholder={t("recurrence.phrasePlaceholder")}
              />
            </Field>
          ) : null}
          {kind === "schedule" && wasUtc && !isUtc(shownZone) && (
            <p className="routine-utc-hint small">
              <Icon name="waiting" size={14} />
              <span>{t("routines.form.utcHint", { zone: timezoneName(shownZone, i18n.language) })}</span>
              <button type="button" className="ac-link" onClick={() => setZone("UTC")}>
                {t("routines.form.keepUtc")}
              </button>
            </p>
          )}
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
          {editing && !(routine && isDoneOnce(routine)) && (
            <label className="routine-active" htmlFor="nr-active">
              <Switch id="nr-active" checked={active} onCheckedChange={setActive} />
              <span>{t("routines.form.active")}</span>
            </label>
          )}
          <Field
            label={t("routines.form.budget")}
            id="nr-budget"
            help={budgetOk ? t("routines.form.budgetHelp") : undefined}
            error={budgetOk ? undefined : t("routines.form.budgetInvalid")}
          >
            <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="5" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("routines.form.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending || !agentId || !scheduleOk || !budgetOk}>
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

/** A run's summary in the UI language (from its code), else the server's words. */
function runSummary(t: TFunction, run: RoutineRun) {
  if (!run.summaryCode) return run.summary;
  const key = `routines.summary.${run.summaryCode.replace(/^routine_run\./, "")}`;
  const tt = t as unknown as (k: string, o: Record<string, unknown>) => string;
  return tt(key, { ...(run.summaryParams ?? {}), defaultValue: run.summary });
}
