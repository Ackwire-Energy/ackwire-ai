import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Composer,
  CriteriaPixels,
  cx,
  Field,
  Icon,
  Message,
  MessageText,
  Select,
  WorkSweep,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useChannels, useIssue, useIssueAction, useIssueActivity } from "@/api/queries";
import type { Issue, IssueActivity, IssuePriority, IssueStatus } from "@/api/types";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, useActors } from "@/components/actors";
import { useArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { useOrg } from "@/components/org-context";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { useMentionSearch } from "@/hooks/useMentionSearch";
import { dueLabel, relativeTime, whenAt } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { isOpen, PRIORITIES, STATUS_ICON, STATUSES, useAssigneeColor, useStepText } from "@/lib/issues";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import "./issues.css";

/** One issue as a page (`/issues/131`); the board opens the same details in its panel. */
export function IssuePage({ number }: { number: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const issue = useIssue(org.id, number);
  return (
    <div className="page page--xwide">
      <Link to="/org/$orgId/issues" params={{ orgId: org.id }} className="ac-back">
        <Icon name="chevronLeft" />
        {t("issues.back")}
      </Link>
      {issue.isError && <Alert>{t("issues.notFound")}</Alert>}
      {issue.data && <IssueDetails issue={issue.data} variant="page" />}
    </div>
  );
}

/**
 * An issue's details (telas/Issues.html): source, status and who, the agent's
 * work (live steps, or "stalled" with "Pedir para continuar"), "Pedir a um
 * agente", description, criteria (who checked them), links and activity.
 */
export function IssueDetails({
  issue: i,
  variant,
  onClose,
}: {
  issue: Issue;
  variant: "page" | "panel";
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const wikiLink = useWikiLinkRenderer();
  const action = useIssueAction(org.id);
  const channels = useChannels(org.id);
  const color = useAssigneeColor();
  const done = i.criteria.filter((c) => c.done).length;
  const source = () => {
    switch (i.source.type) {
      case "message": {
        const { channelId } = i.source;
        const channel = channels.data?.find((c) => c.id === channelId);
        return (
          <Trans
            i18nKey="issues.fromMessage"
            values={{ channel: channel?.name ?? "" }}
            components={[
              <Link key="l" to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId }} className="ac-link" />,
            ]}
          />
        );
      }
      case "forum":
        return t("issues.fromForum");
      case "agent":
        return t("issues.fromAgent");
      case "webhook":
        return t("issues.fromWebhook", { provider: i.source.provider });
      default:
        return null;
    }
  };
  const from = source();
  const Title = variant === "page" ? "h1" : "h2";
  const main = (
    <>
      <header className="issue-details__head">
        {variant === "panel" && (
          <div className="issue-details__bar">
            <span className="tabular muted">#{i.number}</span>
            <span className="issue-details__grow" />
            <Link
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(i.number) }}
              className="ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon"
              aria-label={t("issues.openPage")}
              title={t("issues.openPage")}
            >
              <Icon name="external" size={16} />
            </Link>
            <Button variant="ghost" size="sm" iconOnly icon="close" aria-label={t("issues.close")} onClick={onClose} />
          </div>
        )}
        <span className="small muted tabular">
          {t("issues.createdBy", { number: i.number, name: actors.name(i.createdBy) })}
          {from && <> {from}</>}
        </span>
        <Title className="issue-details__title">{i.title}</Title>
      </header>
      {variant === "panel" && <Details issue={i} />}
      <WorkBox issue={i} />
      {i.assignee?.type !== "agent" && isOpen(i) && <AskAgent issue={i} />}
      <section aria-label={t("issues.description")} className="issue-details__section">
        <h3 className="ac-eyebrow">{t("issues.description")}</h3>
        {i.description ? (
          <div className="issue-description">
            <Markdown source={i.description} variant="message" wikiLink={wikiLink} />
          </div>
        ) : (
          <p className="small muted">{t("issues.noDescription")}</p>
        )}
      </section>
      <section aria-label={t("issues.criteria")} className="issue-details__section">
        <h3 className="ac-eyebrow issue-details__row">
          {t("issues.criteria")}
          {i.criteria.length > 0 && (
            <span className="issue-details__count tabular">
              {t("issues.criteriaCount", { done, total: i.criteria.length })}
            </span>
          )}
        </h3>
        {i.criteria.length === 0 && <p className="small muted">{t("issues.noCriteria")}</p>}
        {i.criteria.length > 0 && <CriteriaPixels done={i.criteria.map((c) => c.done)} color={color(i)} />}
        {i.criteria.map((c) => (
          <div key={c.id} className="issue-criterion" data-done={c.done || undefined}>
            <Checkbox
              id={`crit-${c.id}`}
              checked={c.done}
              onCheckedChange={(v) => action.mutate({ type: "criterion", id: i.id, criterionId: c.id, done: v })}
            />
            <label htmlFor={`crit-${c.id}`}>{c.text}</label>
            {c.done && c.doneBy?.type === "agent" && (
              <span className="issue-criterion__by" title={t("issues.checkedBy", { name: actors.name(c.doneBy) })}>
                <ActorAvatar actor={c.doneBy} name={actors.name(c.doneBy)} size="xs" />
                {actors.name(c.doneBy)}
              </span>
            )}
          </div>
        ))}
      </section>
      {variant === "panel" && <Links issue={i} />}
      <Activity issue={i} />
    </>
  );
  if (variant === "panel") return <div className="issue-details issue-details--panel">{main}</div>;
  return (
    <div className="issue-layout">
      <div className="issue-details issue-layout__main">{main}</div>
      <aside aria-label={t("issues.details")} className="issue-aside">
        <Details issue={i} bare />
        <Links issue={i} />
      </aside>
    </div>
  );
}

/** The assigned agent's work: live steps (with Parar) or stalled (with "Pedir para continuar"). */
function WorkBox({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const color = useAssigneeColor();
  const stepText = useStepText();
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.issues(org.id) }),
  });
  const w = i.work;
  if (!w || !i.assignee || i.assignee.type !== "agent") return null;
  const name = actors.name(i.assignee);
  const g = agentGrammar(t, name);
  const stalled = w.state === "stalled";
  const waiting = w.state === "waiting_approval" || w.state === "waiting_input";
  const when = relativeTime(t, i18n.language, w.since);
  const last = w.steps.at(-1);
  return (
    <section className={cx("issue-work", stalled && "is-stalled")} aria-label={t("issues.work.label", g)}>
      <div className="issue-work__head">
        <AgentAvatar
          agentId={i.assignee.id}
          name={name}
          size="sm"
          running={w.state === "running"}
          state={w.state === "running" ? "writing" : "idle"}
          expression={stalled ? "closed" : undefined}
        />
        <span className="issue-work__text">
          <b>
            {stalled
              ? t("issues.work.stalledTitle", { ...g, when })
              : waiting
                ? t("issues.work.waitingTitle", g)
                : t("issues.work.runningTitle", g)}
          </b>
          <small>{stalled ? t("issues.work.stalledText", g) : t("issues.work.started", { when })}</small>
        </span>
        {w.state === "running" && w.runId && (
          <Button
            size="sm"
            variant="ghost"
            icon="stop"
            loading={stop.isPending}
            onClick={() => w.runId && stop.mutate(w.runId)}
          >
            {t("issues.work.stop")}
          </Button>
        )}
      </div>
      {stalled ? (
        <>
          {last && <p className="issue-work__last">{t("issues.work.lastStep", { step: stepText(last) })}</p>}
          {w.reason && <p className="issue-work__last">{t(`issues.work.reason.${w.reason}`)}</p>}
          <div className="issue-work__actions">
            <Button
              size="sm"
              variant="primary"
              icon="play"
              loading={action.isPending}
              onClick={() =>
                action.mutate(
                  { type: "ask", id: i.id, agentId: i.assignee?.id ?? "" },
                  { onSuccess: () => toast.show(t("issues.work.resumed", g)) },
                )
              }
            >
              {t("issues.work.continue")}
            </Button>
          </div>
        </>
      ) : (
        w.steps.length > 0 && (
          <ol className="issue-work__steps">
            {w.steps.map((s, k) => {
              const current = k === w.steps.length - 1;
              return (
                <li key={`${s.at}-${s.tool}`} className={cx(current && "is-current")}>
                  <span className="issue-work__dot" aria-hidden="true">
                    <Icon name={current ? "play" : "check"} size={14} />
                  </span>
                  <span>{stepText(s)}</span>
                  <time dateTime={s.at}>{whenAt(t, i18n.language, s.at)}</time>
                </li>
              );
            })}
          </ol>
        )
      )}
      {!stalled && <WorkSweep color={color(i) ?? "sky"} waiting={waiting} />}
    </section>
  );
}

/** The agents offered by "Pedir a um agente": a developer first, then the others. */
function useAgentChoices() {
  const { dir } = useActors();
  const dev = dir.agents.find((a) => /dev|engenh|program|cód/i.test(`${a.role} ${a.name}`)) ?? dir.agents[0];
  return dev ? [dev, ...dir.agents.filter((a) => a.id !== dev.id)] : [];
}

function AskAgent({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const { avatar } = useActors();
  const [agent, ...others] = useAgentChoices();
  if (!agent) return null;
  const ask = (a: { id: string; name: string }) => {
    const g = agentGrammar(t, a.name);
    action.mutate(
      { type: "ask", id: issue.id, agentId: a.id },
      { onSuccess: () => toast.show(t("issues.asked", { The: g.The, name: a.name })) },
    );
  };
  const g = agentGrammar(t, agent.name);
  return (
    <section aria-label={t("issues.askSection")} className="issue-ask">
      <div className="issue-ask__row">
        {avatar({ type: "agent", id: agent.id }, "sm")}
        <span className="issue-ask__text">
          <b>{t("issues.askTitle", { to: g.to, name: agent.name })}</b>
          <span className="small muted">{t("issues.askText", { The: g.The, name: agent.name })}</span>
        </span>
      </div>
      <div className="issue-ask__actions">
        <Button
          variant="agent"
          icon="agent"
          size="sm"
          disabled={action.isPending}
          loading={action.isPending}
          onClick={() => ask(agent)}
        >
          {t("issues.askButton", { to: g.to, name: agent.name })}
        </Button>
        {others.slice(0, 3).map((a) => (
          <button key={a.id} type="button" className="issue-ask__other" onClick={() => ask(a)}>
            {avatar({ type: "agent", id: a.id }, "xs")}
            {a.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function Activity({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const activity = useIssueActivity(org.id, issue.id);
  const action = useIssueAction(org.id);
  const actors = useActors();
  const [text, setText] = useState("");
  const mentionSearch = useMentionSearch();
  // The event in the person's language from its code (`issues.event.*`); the server's words as the fallback.
  const eventText = (a: IssueActivity) => {
    if (!a.textCode) return a.text;
    const p = a.textParams ?? {};
    const extra = {
      ...(p.status ? { status: t(`issues.status.${p.status}`, { defaultValue: p.status }) } : {}),
      ...(p.priority ? { priority: t(`issues.priority.${p.priority}`, { defaultValue: p.priority }) } : {}),
    };
    return t(`issues.event.${a.textCode}`, { ...p, ...extra, defaultValue: a.text });
  };
  const list = activity.data ?? [];
  return (
    <section aria-label={t("issues.activity")} className="issue-details__section">
      <h3 className="ac-eyebrow">{t("issues.activity")}</h3>
      {activity.isSuccess && list.length === 0 && <p className="small muted">{t("issues.noActivity")}</p>}
      {list.map((a) =>
        a.kind === "event" ? (
          <div key={a.id} className="issue-event small muted">
            <Icon name={a.event === "agent_asked" ? "agent" : "waiting"} size={16} />
            <span>
              <b className="issue-event__who">{actors.name(a.author)}</b> {eventText(a)}
              {a.auto && (
                <Chip icon="repeat" className="issue-event__auto" title={t("issues.autoHint")}>
                  {t("issues.auto")}
                </Chip>
              )}{" "}
              · {whenAt(t, i18n.language, a.createdAt)}
            </span>
          </div>
        ) : (
          <Message
            key={a.id}
            agent={a.author.type === "agent"}
            avatar={<ActorAvatar actor={a.author} name={actors.name(a.author)} />}
            author={actors.name(a.author)}
            time={<time dateTime={a.createdAt}>{whenAt(t, i18n.language, a.createdAt)}</time>}
          >
            <MessageText style={{ whiteSpace: "pre-line" }}>{a.text}</MessageText>
          </Message>
        ),
      )}
      <Composer
        value={text}
        onChange={setText}
        label={t("issues.comment")}
        placeholder={t("issues.commentPlaceholder")}
        sendLabel={t("issues.send")}
        mentions={{ search: mentionSearch, listLabel: t("mentions.list") }}
        disabled={action.isPending}
        onSend={(body) => {
          if (!body) return;
          action.mutate({ type: "comment", id: issue.id, text: body }, { onSuccess: () => setText("") });
        }}
      />
    </section>
  );
}

/** Status, who, priority and due date (the page's aside; at the top of the panel). */
function Details({ issue: i, bare = false }: { issue: Issue; bare?: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const fields = (
    <>
      <Field label={t("issues.statusLabel")} id={`is-status-${i.id}`} help={t("issues.statusHint")}>
        <Select
          size="sm"
          value={i.status}
          onValueChange={(v) => action.mutate({ type: "update", id: i.id, patch: { status: v as IssueStatus } })}
          options={STATUSES.map((s) => ({
            value: s,
            label: t(`issues.status.${s}`),
            leading: <Icon name={STATUS_ICON[s]} size={16} />,
          }))}
        />
      </Field>
      <Field label={t("issues.form.assignee")} id={`is-who-${i.id}`}>
        <Select
          size="sm"
          value={actorKey(i.assignee)}
          onValueChange={(v) => action.mutate({ type: "update", id: i.id, patch: { assignee: actorFromKey(v) } })}
          options={actors.options(true)}
        />
      </Field>
      <Field label={t("issues.form.priority")} id={`is-pri-${i.id}`}>
        <Select
          size="sm"
          value={i.priority}
          onValueChange={(v) => action.mutate({ type: "update", id: i.id, patch: { priority: v as IssuePriority } })}
          options={PRIORITIES.map((p) => ({ value: p, label: t(`issues.priority.${p}`) }))}
        />
      </Field>
      <div className="issue-aside__item">
        <span className="ac-field__label">{t("issues.due")}</span>
        {i.dueDate ? (
          <span className="row" style={{ gap: 6 }}>
            <Icon name="calendar" size={16} />
            {dueLabel(t, i18n.language, i.dueDate)} ·{" "}
            <Link to="/org/$orgId/calendar" params={{ orgId: org.id }} className="ac-link">
              {t("issues.seeCalendar")}
            </Link>
          </span>
        ) : (
          <span className="small muted">{t("issues.noDue")}</span>
        )}
      </div>
    </>
  );
  if (bare) return fields;
  return (
    <aside aria-label={t("issues.details")} className="issue-props">
      {fields}
    </aside>
  );
}

function Links({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const actors = useActors();
  const viewer = useArtifactViewer();
  return (
    <>
      <div className="issue-aside__item">
        <span className="ac-field__label">{t("issues.links")}</span>
        {i.pullRequests.length + i.artifacts.length === 0 && <span className="small muted">{t("issues.noLinks")}</span>}
        {i.pullRequests.map((pr) => (
          <a key={pr.number} href={pr.url} target="_blank" rel="noopener noreferrer" className="issue-link">
            <Icon name="pullRequest" size={16} />
            {pr.openedBy
              ? t("issues.prBy", { number: pr.number, name: actors.name(pr.openedBy) })
              : t("issues.pr", { number: pr.number })}
          </a>
        ))}
        {i.artifacts.map((a) => (
          <button key={a.id} type="button" className="issue-link" onClick={() => viewer.open(a.id)}>
            <Icon name="drive" size={16} />
            {t("issues.artifactBy", { title: a.title, name: actors.name(a.createdBy) })}
          </button>
        ))}
      </div>
      {i.labels.length > 0 && (
        <div className="issue-aside__item">
          <span className="ac-field__label">{t("issues.labels")}</span>
          <span className="row" style={{ gap: 6 }}>
            {i.labels.map((l) => (
              <span key={l} className="ac-chip issue-label">
                {l}
              </span>
            ))}
          </span>
        </div>
      )}
    </>
  );
}
