import { Button, Chip, Icon, type IconName, RadioCard, RadioGroup, Select, Skeleton, Textarea } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import {
  useMission,
  useMissionAct,
  useMissionControl,
  useMissionDecisions,
  useMissionPlan,
  useMissionReviews,
  useSetMissionExecutor,
  useThreadTasks,
} from "@/api/missions";
import type {
  Message,
  Mission,
  MissionDecision,
  MissionExecutor,
  MissionPlanMeta,
  MissionReportMeta,
  MissionSuggestionMeta,
} from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { errorText } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import {
  executorName,
  formatSpan,
  missionCardRef,
  missionPlanChangeOf,
  planChangeParts,
  planCounts,
  summaryParts,
  taskNoticeOf,
  viaText,
} from "@/lib/missions";
import { useToast } from "@/lib/toast";
import { executorOptions, useMissionPanel } from "./MissionBits";
import { SessionRows } from "./MissionSessions";

/**
 * The mission's cards and lines inside the thread (ThreadContexto.html,
 * "App mobile"): the plan card (Começar / Mudar algo), the decision card,
 * the review card ("Pronto para você ver"), the plan-change line, the
 * computer and task lines, a report's "via Claude Code no …", the
 * suggestion bar on a person's message, and the `/summary` and `/plan`
 * cards only the person who typed them sees.
 */

const firstSentence = (text: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (m?.[1] ?? text).trim();
};

/** "Começou" over a card for a moment after a click (reduced motion: none). */
function useStamp() {
  const [stamp, setStamp] = useState<string | null>(null);
  const show = (text: string) => {
    setStamp(text);
    setTimeout(() => setStamp(null), 900);
  };
  const node = stamp ? (
    <div className="mi-stamp" role="status">
      <span className="mi-ok">
        <Icon name="check" size={16} />
      </span>
      {stamp}
    </div>
  ) : null;
  return { show, node };
}

// ── Plan card ─────────────────────────────────────────────────────────────────

const PLAN_SHOWN = 5;

export function MissionPlanCard({ plan: meta }: { plan: MissionPlanMeta }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const panel = useMissionPanel();
  const actions = useChannelActions();
  const mission = useMission(org.id, meta.missionId);
  const plan = useMissionPlan(org.id, meta.missionId);
  const control = useMissionControl(org.id);
  const switchExecutor = useSetMissionExecutor(org.id);
  const stamp = useStamp();
  const m = mission.data;
  const agentName = dir.agentById.get(m?.agentId ?? "")?.name ?? "";
  const current = m?.executor ?? meta.executor;
  const executor = executorName(current, agentName);
  // Before Start the owner may switch who programs, among those the computer can run.
  const choices = m?.role === "owner" && m.status === "proposed" ? (m.machine?.executors ?? []) : [];
  const items = (plan.data?.current?.items ?? []).filter((i) => i.status !== "dropped");
  const computer = m?.machine?.name ?? meta.computer;
  const seePlan = () => panel?.openFiles(meta.missionId, "mission.md");
  if (m && m.status !== "proposed") {
    return (
      <div className="mi-created">
        <span className="mi-ok">
          <Icon name={m.status === "canceled" ? "close" : "check"} size={16} />
        </span>
        <span className="mi-decided__t">
          <b>{t(`missions.plan.after.${m.status}`)}</b>
          <small>{t("missions.plan.afterLine", { count: m.plan.total, computer })}</small>
        </span>
        {panel && (
          <Button size="sm" icon="document" onClick={seePlan}>
            {t("missions.plan.see")}
          </Button>
        )}
      </div>
    );
  }
  const start = () =>
    control.mutate(
      { missionId: meta.missionId, action: "start" },
      {
        onSuccess: () => {
          stamp.show(t("missions.plan.started"));
          toast.show(
            t("missions.plan.startedToast"),
            "info",
            panel ? { label: t("missions.plan.see"), run: seePlan } : undefined,
          );
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  const owner = m?.ownerId ? dir.memberById.get(m.ownerId)?.name : undefined;
  return (
    <div className="mi-card mi-plan">
      <div className="mi-plan__head">
        <span className="mi-cap">
          <Icon name="code" size={14} />
          {t("missions.plan.cap", { executor })}
        </span>
        <h3>{meta.title}</h3>
        <p>{firstSentence(meta.goal)}</p>
      </div>
      {plan.isPending ? (
        <div className="mi-plan__list" aria-hidden="true">
          <Skeleton width="60%" />
          <Skeleton width="45%" />
        </div>
      ) : items.length > 0 ? (
        <ul className="mi-plan__list">
          {items.slice(0, PLAN_SHOWN).map((i) => (
            <li key={i.id}>
              <span className={i.status === "done" ? "mi-box mi-box--on" : "mi-box"} aria-hidden="true">
                {i.status === "done" && <Icon name="check" size={14} />}
              </span>
              {i.title}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mi-plan__note mi-plan__note--first">
          {t("missions.plan.exploring", { executor })}
          <span className="mi-cursor" aria-hidden="true" />
        </p>
      )}
      {items.length > 0 && (
        <p className="mi-plan__note">
          {items.length > PLAN_SHOWN ? `${t("missions.plan.more", { count: items.length - PLAN_SHOWN })} · ` : ""}
          {t("missions.plan.adjusts", { executor })}
        </p>
      )}
      <div className="mi-plan__meta">
        <Icon name="computer" size={14} />
        <span>
          {t("missions.plan.on", {
            computer,
            state: m?.machine && !m.machine.online ? t("missions.offline") : t("missions.online"),
          })}
        </span>
      </div>
      {m && choices.length > 1 && (
        <div className="mi-plan__meta">
          <Icon name="code" size={14} />
          <span>{t("missions.new.who")}</span>
          <div style={{ minWidth: 200 }}>
            <Select
              size="sm"
              aria-label={t("missions.new.who")}
              value={current}
              disabled={switchExecutor.isPending}
              onValueChange={(v) =>
                switchExecutor.mutate(
                  { missionId: m.id, executor: v as MissionExecutor },
                  {
                    onSuccess: () => toast.show(t("missions.plan.switched", { executor: executorName(v, agentName) })),
                    onError: (error) => toast.show(errorText(t, error), "error"),
                  },
                )
              }
              options={executorOptions(t, choices, agentName)}
            />
          </div>
        </div>
      )}
      <div className="mi-plan__foot">
        {m?.role === "owner" && (
          <Button variant="primary" size="sm" icon="check" loading={control.isPending} onClick={start}>
            {t("missions.plan.start")}
          </Button>
        )}
        {m?.canAct && actions?.replyToMission && (
          <Button
            size="sm"
            icon="edit"
            onClick={() => actions.replyToMission?.(meta.missionId, t("missions.plan.label"))}
          >
            {t("missions.plan.change")}
          </Button>
        )}
        {m && m.role !== "owner" && owner && (
          <span className="mi-hint">{t("missions.plan.ownerStarts", { name: owner })}</span>
        )}
      </div>
      {stamp.node}
    </div>
  );
}

// ── Decision card ─────────────────────────────────────────────────────────────

export function MissionDecisionCard({ message }: { message: Message }) {
  const ref = missionCardRef(message.meta, "missionDecision");
  const { org } = useOrg();
  const decisions = useMissionDecisions(org.id, ref?.missionId);
  const mission = useMission(org.id, ref?.missionId);
  const d = decisions.data?.find((x) => x.id === ref?.id);
  if (!ref) return null;
  if (!d || !mission.data) {
    return decisions.isPending || mission.isPending ? (
      <div className="mi-card" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  return <DecisionBody decision={d} mission={mission.data} />;
}

function DecisionBody({ decision: d, mission: m }: { decision: MissionDecision; mission: Mission }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const panel = useMissionPanel();
  const stamp = useStamp();
  const [pick, setPick] = useState<string | null>(d.status === "provisional" ? d.chosen : null);
  const choose = useMissionAct(org.id, m.id, (option: string) => api.missions.choose(org.id, m.id, d.id, option));
  const opine = useMissionAct(org.id, m.id, (option: string) => api.missions.opinion(org.id, m.id, d.id, option));
  const name = (id: string | null) => (id ? (dir.memberById.get(id)?.name ?? t("missions.someone")) : "");
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  if (d.status === "taken") {
    return (
      <div className="mi-card">
        <div className="mi-decided">
          <span className="mi-ok">
            <Icon name="check" size={16} />
          </span>
          <span className="mi-decided__t">
            <b>{t("missions.decision.taken", { question: d.question, option: d.chosen ?? "" })}</b>
            <small>
              {t("missions.decision.takenBy", {
                name: name(d.chosenBy),
                time: d.chosenAt ? formatTime(i18n.language, d.chosenAt) : "",
              })}{" "}
              <code className="mi-mono">{DECISIONS_FILE}</code>
            </small>
          </span>
          {panel && (
            <Button size="sm" icon="document" onClick={() => panel.openFiles(m.id, "decisions.md")}>
              {t("missions.decision.seeFile")}
            </Button>
          )}
        </div>
      </div>
    );
  }
  const canDecide = m.canAct;
  const canOpine = !m.canAct && m.role === "comment";
  const interactive = canDecide || canOpine;
  const mine = d.opinions.find((o) => o.userId === me.user.id);
  const submit = () => {
    if (!pick) return;
    if (canDecide) {
      choose.mutate(pick, {
        onSuccess: () => {
          stamp.show(t("missions.decision.decided"));
          toast.show(
            t("missions.decision.decidedToast"),
            "info",
            panel
              ? { label: t("missions.decision.seeFile"), run: () => panel.openFiles(m.id, "decisions.md") }
              : undefined,
          );
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      });
    } else if (canOpine) {
      opine.mutate(pick, {
        onSuccess: () => toast.show(t("missions.decision.opinionToast", { option: pick })),
        onError: (error) => toast.show(errorText(t, error), "error"),
      });
    }
  };
  return (
    <div className="mi-card">
      <div className="mi-tags">
        {d.blocking ? (
          <Chip icon="lock">{t("missions.decision.blocking")}</Chip>
        ) : (
          <Chip icon="clock">{t("missions.decision.provisional", { option: d.chosen ?? "" })}</Chip>
        )}
        <Chip icon="code">{viaText(t, m.executor, agentName, m.machine?.name)}</Chip>
      </div>
      <div className="mi-q">
        <h3>{d.question}</h3>
      </div>
      <RadioGroup className="mi-opts" value={pick ?? ""} onValueChange={(v) => setPick(v)} aria-label={d.question}>
        {d.options.map((o, i) => (
          <RadioCard
            key={o}
            value={o}
            id={`decision-${d.id}-${i}`}
            checked={pick === o}
            disabled={!interactive}
            title={o}
            description={
              opinionsFor(d, o).length > 0
                ? t("missions.decision.prefers", { names: opinionsFor(d, o).map(name).join(", ") })
                : undefined
            }
            aside={d.recommendation === o ? <Chip icon="bolt">{t("missions.decision.recommended")}</Chip> : undefined}
          />
        ))}
      </RadioGroup>
      {(d.why || d.impact) && (
        <div className="mi-why">
          {d.why && (
            <>
              <span className="mi-why__k">
                <AgentAvatar agentId={m.agentId} name={dir.agentById.get(m.agentId)?.name ?? ""} size="xs" />
                {t("missions.decision.why")}
              </span>
              <span>{d.why}</span>
            </>
          )}
          {d.impact && (
            <>
              <span className="mi-why__k">{t("missions.decision.impact")}</span>
              <span>{d.impact}</span>
            </>
          )}
        </div>
      )}
      <div className="mi-foot">
        {canDecide && (
          <Button variant="primary" size="sm" icon="check" disabled={!pick} loading={choose.isPending} onClick={submit}>
            {pick ? t("missions.decision.decide", { option: pick }) : t("missions.decision.pick")}
          </Button>
        )}
        {canOpine && (
          <Button size="sm" icon="message" disabled={!pick} loading={opine.isPending} onClick={submit}>
            {pick ? t("missions.decision.opine", { option: pick }) : t("missions.decision.pick")}
          </Button>
        )}
        {!interactive && <span className="mi-hint">{t("missions.decision.readOnly")}</span>}
        {mine && canOpine && (
          <span className="mi-hint">{t("missions.decision.yourOpinion", { option: mine.option })}</span>
        )}
        <span className="mi-foot__grow" />
        <span className="mi-hint">
          <Icon name="document" size={14} />
          {t("missions.decision.goesTo")} <code>{DECISIONS_FILE}</code>
        </span>
      </div>
      {stamp.node}
    </div>
  );
}

const DECISIONS_FILE = ".agentes/decisions.md";
const opinionsFor = (d: MissionDecision, option: string) =>
  d.opinions.filter((o) => o.option === option).map((o) => o.userId);

// ── Review card ───────────────────────────────────────────────────────────────

export function MissionReviewCard({ message }: { message: Message }) {
  const ref = missionCardRef(message.meta, "missionReview");
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const reviews = useMissionReviews(org.id, ref?.missionId);
  const mission = useMission(org.id, ref?.missionId);
  const stamp = useStamp();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const missionId = ref?.missionId ?? "";
  const review = useMissionAct(
    org.id,
    missionId,
    ({ outcome, note: n }: { outcome: "approve" | "changes"; note?: string }) =>
      api.missions.review(org.id, missionId, ref?.id ?? "", outcome, n),
  );
  const r = reviews.data?.find((x) => x.id === ref?.id);
  const m = mission.data;
  if (!ref) return null;
  if (!r || !m) {
    return reviews.isPending ? (
      <div className="mi-card" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  const who = r.decidedBy ? (dir.memberById.get(r.decidedBy)?.name ?? t("missions.someone")) : "";
  if (r.status !== "pending") {
    return (
      <div className="mi-card">
        <div className="mi-decided">
          <span className="mi-ok">
            <Icon name={r.status === "approved" ? "check" : "edit"} size={16} />
          </span>
          <span className="mi-decided__t">
            <b>
              {r.status === "approved"
                ? t("missions.review.approved", { title: r.title })
                : t("missions.review.changesAsked", { title: r.title })}
            </b>
            <small>
              {t("missions.review.by", { name: who, time: r.decidedAt ? formatTime(i18n.language, r.decidedAt) : "" })}
              {r.note ? ` · ${r.note}` : ""}
            </small>
          </span>
        </div>
      </div>
    );
  }
  const send = (outcome: "approve" | "changes") =>
    review.mutate(
      { outcome, ...(outcome === "changes" ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          stamp.show(outcome === "approve" ? t("missions.review.approvedStamp") : t("missions.review.sentStamp"));
          setAsking(false);
          setNote("");
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  return (
    <div className="mi-card">
      <div className="mi-q">
        <h3>{t("missions.review.ready", { title: r.title })}</h3>
        {r.summary && <p>{r.summary}</p>}
      </div>
      {r.artifactIds.length > 0 && (
        <div className="artifact-cards">
          {r.artifactIds.map((id) => (
            <ArtifactCard key={id} artifact={{ id }} />
          ))}
        </div>
      )}
      {r.prUrl && (
        <div className="mi-pills" style={{ marginTop: 10 }}>
          <a className="mi-pr" href={r.prUrl} target="_blank" rel="noreferrer">
            <Icon name="pullRequest" size={14} />
            {t("missions.review.openPr")}
          </a>
        </div>
      )}
      {asking && (
        <div className="mi-note">
          <Textarea
            value={note}
            rows={3}
            autoFocus
            aria-label={t("missions.review.noteLabel")}
            placeholder={t("missions.review.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {m.canAct ? (
        <div className="mi-foot">
          {asking ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon="send"
                disabled={!note.trim()}
                loading={review.isPending}
                onClick={() => send("changes")}
              >
                {t("missions.review.sendChanges")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                icon="check"
                loading={review.isPending}
                onClick={() => send("approve")}
              >
                {t("missions.review.approve")}
              </Button>
              <Button size="sm" icon="edit" onClick={() => setAsking(true)}>
                {t("missions.review.askChanges")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="mi-foot">
          <span className="mi-hint">{t("missions.review.readOnly")}</span>
        </div>
      )}
      {stamp.node}
    </div>
  );
}

// ── Lines in the thread ───────────────────────────────────────────────────────

/** "Plano atualizado: + Notificações · − Drawer lateral · Ver plano". */
export function MissionPlanChangeLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const panel = useMissionPanel();
  const change = missionPlanChangeOf(message.meta);
  if (!change) return null;
  const p = planChangeParts(change);
  const parts = [
    ...p.added.map((x) => `+ ${x}`),
    ...p.removed.map((x) => `− ${x}`),
    ...p.done.map((x) => t("missions.planChange.done", { title: x })),
    ...p.renamed.map((x) => t("missions.planChange.renamed", { from: x.from, to: x.to })),
  ];
  return (
    <div className="mi-evt" data-message-id={message.id}>
      <Icon name="edit" size={14} />
      <span>
        <b>{t("missions.planChange.title")}</b>
        {parts.length > 0 ? `: ${parts.join(" · ")}` : ""}
      </span>
      {panel && (
        <button type="button" className="mi-link" onClick={() => panel.openFiles(change.missionId, "mission.md")}>
          {t("missions.plan.see")}
        </button>
      )}
    </div>
  );
}

const NOTICE_ICON: Record<string, IconName> = {
  machine_offline: "computer",
  machine_task_resumed: "refresh",
  machine_task_done: "check",
  machine_task_failed: "alert",
  machine_task_canceled: "stop",
  machine_task_interrupted: "pause",
};

/** The computer went offline, came back, a task ended: one quiet line. */
export function TaskNoticeLine({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const notice = taskNoticeOf(message.meta);
  if (!notice) return null;
  const p = notice.params;
  const seconds = Number(p.seconds ?? 0);
  return (
    <div className="mi-evt" data-message-id={message.id}>
      <Icon name={NOTICE_ICON[notice.code] ?? "computer"} size={14} />
      <span>
        {t(`missions.notice.${notice.code}`, {
          ...p,
          count: Number(p.count ?? 1),
          span: Number.isFinite(seconds) ? formatSpan(t, seconds) : "",
          defaultValue: message.body,
        })}{" "}
        · {formatTime(i18n.language, message.createdAt)}
      </span>
    </div>
  );
}

/** Under an executor's report: "via Claude Code no MacBook do Walter" and its session row. */
export function MissionReportExtras({ report, message }: { report: MissionReportMeta; message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const tasks = useThreadTasks(org.id, message.threadId);
  const task = report.main ? undefined : tasks.data?.find((x) => x.id === report.taskId);
  const dir = useDirectory(org.id);
  const agentName =
    message.author.type === "agent" && message.author.id ? (dir.agentById.get(message.author.id)?.name ?? "") : "";
  return (
    <>
      <span className="mi-tag">
        <Icon name="code" size={14} />
        {viaText(t, report.executor, agentName, report.computer)}
      </span>
      {task && <SessionRows tasks={[task]} defaultOpen />}
    </>
  );
}

/** A person's message that became a suggestion: Aceitar / Recusar for whoever can act. */
export function MissionSuggestionBar({ message, suggestion }: { message: Message; suggestion: MissionSuggestionMeta }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const mission = useMission(org.id, suggestion.missionId);
  const act = useMissionAct(org.id, suggestion.missionId, (outcome: "accept" | "decline") =>
    api.missions.suggestion(org.id, suggestion.missionId, message.id, outcome),
  );
  const [answered, setAnswered] = useState<"accepted" | "declined" | null>(null);
  const status = answered ?? suggestion.status;
  const m = mission.data;
  if (status !== "pending") {
    return (
      <div className="mi-suggest">
        <Chip icon={status === "accepted" ? "check" : "close"}>{t(`missions.suggestion.${status}`)}</Chip>
      </div>
    );
  }
  const answer = (outcome: "accept" | "decline") =>
    act.mutate(outcome, {
      onSuccess: (out) => {
        setAnswered(out.status);
        toast.show(t(`missions.suggestion.${out.status}Toast`));
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  return (
    <div className="mi-suggest">
      <Chip icon="waiting" tone="waiting">
        {t("missions.suggestion.pending")}
      </Chip>
      {m?.canAct ? (
        <>
          <Button size="sm" icon="check" loading={act.isPending} onClick={() => answer("accept")}>
            {t("missions.suggestion.accept")}
          </Button>
          <Button size="sm" variant="ghost" icon="close" onClick={() => answer("decline")}>
            {t("missions.suggestion.decline")}
          </Button>
        </>
      ) : (
        <span>{t("missions.suggestion.waits")}</span>
      )}
    </div>
  );
}

/** In the channel: the root of a mission links to its thread (its work lives there). */
export function MissionStartLink({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Link to="/org/$orgId/threads/$threadId" params={{ orgId: org.id, threadId: message.id }} className="mi-tag mi-lnk">
      <Icon name="flag" size={14} />
      {t("missions.openThread")}
    </Link>
  );
}

// ── `/summary` and `/plan`: only you see them ─────────────────────────────────

export function MissionEphemeral({
  kind,
  missionId,
  onClose,
}: {
  kind: "summary" | "plan";
  missionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const panel = useMissionPanel();
  const summary = useQuery({
    queryKey: keys.missionPart(org.id, missionId, "summary"),
    queryFn: () => api.missions.summary(org.id, missionId),
    enabled: kind === "summary",
    staleTime: 0,
  });
  const plan = useMissionPlan(org.id, missionId, kind === "plan");
  const items = plan.data?.current?.items ?? [];
  const counts = planCounts(items);
  return (
    <section className="mi-card mi-ephemeral" aria-label={t(`missions.ephemeral.${kind}`)}>
      <div className="mi-ephemeral__head">
        <Icon name={kind === "summary" ? "layers" : "document"} size={16} />
        <b>{t(`missions.ephemeral.${kind}`)}</b>
        <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
      </div>
      {kind === "summary" ? (
        summary.data ? (
          <ul>
            {summaryParts(summary.data).map((p) => (
              <li key={p.key}>{t(`missions.summary.${p.key}`, { count: p.count, total: p.total ?? 0 })}</li>
            ))}
          </ul>
        ) : (
          <Skeleton width="60%" />
        )
      ) : plan.data ? (
        <>
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                <span className={i.status === "done" ? "mi-box mi-box--on" : "mi-box"} aria-hidden="true">
                  {i.status === "done" && <Icon name="check" size={14} />}
                </span>
                <span>
                  {i.title}{" "}
                  {i.status !== "todo" && i.status !== "done" && <small>{t(`missions.item.${i.status}`)}</small>}
                </span>
              </li>
            ))}
          </ul>
          <p className="mi-ephemeral__foot">
            {t("missions.ephemeral.planLine", {
              done: counts.done,
              total: counts.total,
              version: plan.data.current?.version ?? 0,
            })}
            {panel && (
              <>
                {" · "}
                <button type="button" className="mi-link" onClick={() => panel.openFiles(missionId, "mission.md")}>
                  {t("missions.files.open")}
                </button>
              </>
            )}
          </p>
        </>
      ) : (
        <Skeleton width="60%" />
      )}
      <p className="mi-ephemeral__foot">{t("missions.ephemeral.onlyYou")}</p>
    </section>
  );
}
