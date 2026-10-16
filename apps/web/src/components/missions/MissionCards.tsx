import {
  Button,
  Checkbox,
  Chip,
  Icon,
  type IconName,
  RadioCard,
  RadioGroup,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import {
  useMission,
  useMissionAct,
  useMissionControl,
  useMissionDecisions,
  useMissionDeliveries,
  useMissionPlan,
  useMissionReviews,
  useSetCommandApproval,
  useSetMissionExecutor,
  useThreadTasks,
} from "@/api/missions";
import type {
  Message,
  Mission,
  MissionDecision,
  MissionExecutor,
  MissionLinkMeta,
  MissionPlanMeta,
  MissionReportMeta,
  MissionSuggestionMeta,
} from "@/api/types";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { errorText } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import {
  executorName,
  formatSpan,
  machineTaskOf,
  missionAutoApprovedOf,
  missionCardRef,
  missionPlanChangeOf,
  planChangeParts,
  planCounts,
  summaryParts,
  taskNoticeOf,
  viaText,
} from "@/lib/missions";
import { useToast } from "@/lib/toast";
import {
  CommandApprovalSelect,
  ExecutorMark,
  executorOptions,
  MissionHead,
  MissionStatusChip,
  useMissionPanel,
} from "./MissionBits";
import { BlockedCommands } from "./MissionCommandCard";
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
          <ExecutorMark executor={current} agentId={m?.agentId} agentName={agentName} />
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
      <div className="mi-plan__metas">
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
            <Select
              size="sm"
              className="mi-plan__who"
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
              options={executorOptions(t, choices, agentName, m.agentId)}
            />
          </div>
        )}
        {m?.canAct && (
          <div className="mi-plan__meta">
            <Icon name="shield" size={14} />
            <span>{t("missions.commandApproval.label")}</span>
            <PlanApprovalSelect mission={m} />
          </div>
        )}
      </div>
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

/** "Pedir aprovação de comandos" on the plan card (and the same choice in Nova missão and ⋯). */
function PlanApprovalSelect({ mission }: { mission: Mission }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const set = useSetCommandApproval(org.id, mission.id);
  return (
    <span className="mi-plan__who">
      <CommandApprovalSelect
        size="sm"
        value={mission.commandApproval}
        disabled={set.isPending}
        onChange={(v) =>
          set.mutate(v, {
            onSuccess: () =>
              toast.show(t("missions.commandApproval.changed", { value: t(`missions.commandApproval.${v}`) })),
            onError: (error) => toast.show(errorText(t, error), "error"),
          })
        }
      />
    </span>
  );
}

/**
 * Commands allowed without a card (`meta.missionAutoApproved`): one quiet
 * line, or one line for several within a minute ("3 comandos", Ver
 * comandos), with Revogar for whoever decides (back to asking for every one).
 */
export function AutoApprovedLine({ messages }: { messages: Message[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const items = messages.flatMap((m) => {
    const a = missionAutoApprovedOf(m.meta);
    return a ? [{ id: m.id, at: m.createdAt, ...a }] : [];
  });
  const first = items[0];
  const missionId = first?.missionId ?? "";
  const mission = useMission(org.id, missionId || undefined);
  const set = useSetCommandApproval(org.id, missionId);
  if (!first) return null;
  const m = mission.data;
  const reason = t(`missions.auto.${first.reason}` as const);
  const canRevoke = Boolean(m?.canAct && m.commandApproval !== "always" && !revoked);
  const revoke = () =>
    set.mutate("always", {
      onSuccess: () => {
        setRevoked(true);
        toast.show(t("missions.auto.revoked"));
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  return (
    <div className="mi-evt mi-evt--auto" data-message-id={first.id}>
      <Icon name="check" size={14} />
      <span>
        {t("missions.auto.label")}:{" "}
        {items.length === 1 ? <code>{first.command}</code> : t("missions.auto.many", { count: items.length })} ·{" "}
        {reason} · {formatTime(i18n.language, first.at)}
      </span>
      {items.length > 1 && (
        <button type="button" className="mi-lnk" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t("missions.auto.hide") : t("missions.auto.show")}
        </button>
      )}
      {canRevoke && (
        <button
          type="button"
          className="mi-lnk"
          title={t("missions.auto.revokeHint")}
          disabled={set.isPending}
          onClick={revoke}
        >
          {t("missions.auto.revoke")}
        </button>
      )}
      {open && items.length > 1 && (
        <ul className="mi-evt__list">
          {items.map((i) => (
            <li key={i.id}>
              <code>{i.command}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Auto approvals in a row, a minute apart at most from the first: one line (first id → the group; the rest hidden). */
export function groupAutoApproved(list: Message[]) {
  const groups = new Map<string, Message[]>();
  const hidden = new Set<string>();
  let current: Message[] | null = null;
  for (const m of list) {
    const a = missionAutoApprovedOf(m.meta);
    const head = current?.[0];
    if (
      a &&
      current &&
      head &&
      missionAutoApprovedOf(head.meta)?.missionId === a.missionId &&
      Date.parse(m.createdAt) - Date.parse(head.createdAt) <= 60_000
    ) {
      current.push(m);
      hidden.add(m.id);
      continue;
    }
    current = a ? [m] : null;
    if (current) groups.set(m.id, current);
  }
  return { groups, hidden };
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
        <span className="mi-pill mi-exec">
          <ExecutorMark executor={m.executor} agentId={m.agentId} agentName={agentName} />
          {viaText(t, m.executor, agentName, m.machine?.name)}
        </span>
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

// ── Delivery card (the end of a mission) ──────────────────────────────────────

/**
 * The mission's end, like an approval (ADR 0029): what was delivered (the
 * summary, the files as thumbnails that open in the Drive), "O que conferir"
 * as items each person checks for themselves, and for the owner or deciders
 * "Concluir missão" (with "Salvar decisões e lições na wiki") or "Pedir
 * ajustes" (a note that resumes the work). Every plan item done and nothing
 * running without a call to complete_mission: the smaller "Tudo pronto" card.
 */
export function MissionDeliveryCard({ message }: { message: Message }) {
  const ref = missionCardRef(message.meta, "missionDelivery");
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const deliveries = useMissionDeliveries(org.id, ref?.missionId);
  const mission = useMission(org.id, ref?.missionId);
  const stamp = useStamp();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [wiki, setWiki] = useState(true);
  const missionId = ref?.missionId ?? "";
  const deliveryId = ref?.id ?? "";
  const accept = useMissionAct(org.id, missionId, (saveToWiki: boolean) =>
    api.missions.acceptDelivery(org.id, missionId, deliveryId, { saveToWiki }),
  );
  const changes = useMissionAct(org.id, missionId, (text: string) =>
    api.missions.requestDeliveryChanges(org.id, missionId, deliveryId, text),
  );
  const check = useMissionAct(org.id, missionId, ({ itemId, checked }: { itemId: string; checked: boolean }) =>
    api.missions.checkDelivery(org.id, missionId, deliveryId, itemId, checked),
  );
  const d = deliveries.data?.find((x) => x.id === ref?.id);
  const m = mission.data;
  if (!ref) return null;
  if (!d || !m) {
    return deliveries.isPending ? (
      <div className="mi-card" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  // A newer delivery replaced this one: it says so in one quiet line.
  if (d.status === "superseded") {
    return (
      <p className="mi-evt">
        <Icon name="refresh" size={14} />
        <span>{t("missions.delivery.superseded")}</span>
      </p>
    );
  }
  const who = d.decidedBy ? (dir.memberById.get(d.decidedBy)?.name ?? t("missions.someone")) : "";
  const time = d.decidedAt ? formatTime(i18n.language, d.decidedAt) : "";
  if (d.status !== "pending") {
    return (
      <section className="mi-card" aria-label={t("missions.delivery.label")}>
        <div className="mi-decided">
          <span className="mi-ok">
            <Icon name={d.status === "accepted" ? "check" : "edit"} size={16} />
          </span>
          <span className="mi-decided__t">
            <b>{d.status === "accepted" ? t("missions.delivery.accepted") : t("missions.delivery.changesAsked")}</b>
            <small>
              {t("missions.review.by", { name: who, time })}
              {d.note ? ` · ${d.note}` : ""}
            </small>
          </span>
        </div>
      </section>
    );
  }
  const decide = m.canAct && m.status !== "done" && m.status !== "canceled";
  const finish = () =>
    accept.mutate(wiki, {
      onSuccess: () => stamp.show(t("missions.delivery.acceptedStamp")),
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  const ask = () =>
    changes.mutate(note.trim(), {
      onSuccess: () => {
        stamp.show(t("missions.delivery.sentStamp"));
        setAsking(false);
        setNote("");
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  const checked = d.checklist.filter((c) => c.checkedBy.includes(me.user.id)).length;
  return (
    <section
      className={d.auto ? "mi-card mi-delivery mi-delivery--auto" : "mi-card mi-delivery"}
      aria-label={t("missions.delivery.label")}
    >
      <div className="mi-tags">
        <Chip icon="flag" tone={decide ? "waiting" : "neutral"}>
          {decide ? t("missions.status.awaitingClose") : t("missions.status.readyToClose")}
        </Chip>
      </div>
      <div className="mi-q">
        <h3>{d.auto ? t("missions.delivery.allDone") : t("missions.delivery.title", { title: m.title })}</h3>
        {d.auto ? (
          <p>{t("missions.delivery.allDoneText")}</p>
        ) : (
          d.summary && <p className="mi-delivery__summary">{d.summary}</p>
        )}
      </div>
      {d.artifactIds.length > 0 && (
        <div className="artifact-cards">
          {d.artifactIds.map((id) => (
            <ArtifactCard key={id} artifact={{ id }} />
          ))}
        </div>
      )}
      {d.checklist.length > 0 && (
        <section className="mi-delivery__check" aria-label={t("missions.delivery.check")}>
          <h4>
            {t("missions.delivery.check")}
            <span>{t("missions.delivery.checked", { done: checked, total: d.checklist.length })}</span>
          </h4>
          <ul>
            {d.checklist.map((c) => {
              const mine = c.checkedBy.includes(me.user.id);
              const others = c.checkedBy.filter((u) => u !== me.user.id);
              return (
                <li key={c.id} data-done={mine || undefined}>
                  <Checkbox
                    id={`dl-${d.id}-${c.id}`}
                    checked={mine}
                    disabled={!m.canAct}
                    onCheckedChange={(v) => check.mutate({ itemId: c.id, checked: v })}
                  />
                  <label htmlFor={`dl-${d.id}-${c.id}`}>{c.text}</label>
                  {others.length > 0 && (
                    <span className="mi-delivery__by" title={others.map((u) => dir.memberById.get(u)?.name).join(", ")}>
                      {others.slice(0, 3).map((u) => (
                        <ActorAvatar
                          key={u}
                          actor={{ type: "person", id: u }}
                          name={dir.memberById.get(u)?.name ?? ""}
                          size="xs"
                        />
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {asking && (
        <div className="mi-note">
          <Textarea
            value={note}
            rows={3}
            autoFocus
            aria-label={t("missions.delivery.noteLabel")}
            placeholder={t("missions.delivery.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {decide ? (
        <div className="mi-foot">
          {asking ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon="send"
                disabled={!note.trim()}
                loading={changes.isPending}
                onClick={ask}
              >
                {t("missions.delivery.sendChanges")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" icon="check" loading={accept.isPending} onClick={finish}>
                {t("missions.delivery.accept")}
              </Button>
              <Button size="sm" icon="edit" disabled={accept.isPending} onClick={() => setAsking(true)}>
                {t("missions.delivery.askChanges")}
              </Button>
              <span className="mi-delivery__wiki">
                <Switch id={`dl-wiki-${d.id}`} checked={wiki} onCheckedChange={setWiki} />
                <label htmlFor={`dl-wiki-${d.id}`}>{t("missions.delivery.saveToWiki")}</label>
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="mi-foot">
          <span className="mi-hint">{t("missions.delivery.readOnly")}</span>
        </div>
      )}
      {stamp.node}
    </section>
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
    // Only the wording changed: the new title, marked edited (the old one in the tooltip).
    ...p.renamed.map((x) => t("missions.planChange.renamed", { to: x.to })),
  ];
  const before = p.renamed.map((x) => `${x.from} → ${x.to}`).join("\n");
  return (
    <div className="mi-evt" data-message-id={message.id}>
      <Icon name="edit" size={14} />
      <span title={before || undefined}>
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
  // Commands it was refused: one line, the list in a dialog.
  const task = machineTaskOf(message.meta);
  const blocked = task?.blocked ?? [];
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
      {blocked.length > 0 && task?.missionId && (
        <BlockedCommands missionId={task.missionId} taskId={task.id} blocked={blocked} />
      )}
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
      <span className="mi-tag mi-exec">
        <ExecutorMark executor={report.executor} agentId={message.author.id ?? undefined} agentName={agentName} />
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

// ── The mission's link card, where it was asked ───────────────────────────────

/**
 * Under the agent's reply in the conversation where the person asked, when
 * the mission lives in another thread (a flat DM): its title, its state
 * (live via `mission.updated`), who works on which computer, and Abrir
 * thread / Ver plano.
 */
export function MissionLinkCard({ link }: { link: MissionLinkMeta }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const panel = useMissionPanel();
  const mission = useMission(org.id, link.missionId);
  const m = mission.data;
  const threadLink = {
    to: "/org/$orgId/threads/$threadId" as const,
    params: { orgId: org.id, threadId: link.threadId },
  };
  if (!m) {
    return mission.isPending ? (
      <div className="mi-card mi-linkcard" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  const offline = Boolean(m.machine && !m.machine.online);
  // Before Start: still planning, or the plan is there and waits for the person who asked.
  const proposed = m.status === "proposed" ? (m.plan.total > 0 ? "ready" : "planning") : null;
  return (
    <section className="mi-card mi-linkcard" aria-label={t("missions.link.label", { title: m.title })}>
      <MissionHead
        agentId={m.agentId}
        agentName={agentName}
        running={m.runningTasks > 0 && !offline}
        title={<Link {...threadLink}>{m.title}</Link>}
        meta={[
          <span key="via" className="mi-exec">
            <ExecutorMark executor={m.executor} agentId={m.agentId} agentName={agentName} />
            {viaText(t, m.executor, agentName, m.machine?.name)}
          </span>,
        ]}
        right={
          proposed ? (
            <Chip
              icon={proposed === "ready" ? "waiting" : "document"}
              tone={proposed === "ready" && m.role === "owner" ? "waiting" : "neutral"}
            >
              {proposed === "planning"
                ? t("missions.link.status.planning")
                : m.role === "owner"
                  ? t("missions.link.status.ready")
                  : t("missions.link.status.readyOther")}
            </Chip>
          ) : (
            <MissionStatusChip mission={m} />
          )
        }
      />
      <div className="mi-linkcard__foot">
        <Button size="sm" variant="primary" icon="thread" onClick={() => void navigate(threadLink)}>
          {t("missions.list.openThread")}
        </Button>
        <Button
          size="sm"
          icon="document"
          onClick={() => (panel ? panel.openFiles(m.id, "mission.md") : void navigate(threadLink))}
        >
          {t("missions.plan.see")}
        </Button>
      </div>
    </section>
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
