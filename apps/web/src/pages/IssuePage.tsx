import { Alert, Avatar, Button, Checkbox, Composer, Field, Icon, Message, MessageText, Select } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useChannels, useIssue, useIssueAction, useIssueActivity } from "@/api/queries";
import type { Issue, IssueActivity, IssuePriority, IssueStatus } from "@/api/types";
import { actorFromKey, actorKey, useActors } from "@/components/actors";
import { useArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { useOrg } from "@/components/org-context";
import { useMentionSearch } from "@/hooks/useMentionSearch";
import { dueLabel, whenAt } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { useToast } from "@/lib/toast";
import { PRIORITIES, STATUSES } from "./IssuesPage";

/** One issue (telas/Issue.dc.html): criteria, "Pedir à Ada", activity and the details aside. */
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
      {issue.data && <IssueBody issue={issue.data} />}
    </div>
  );
}

function IssueBody({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const channels = useChannels(org.id);
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
  return (
    <div className="issue-layout">
      <div className="issue-layout__main">
        <header className="stack-4" style={{ gap: 6 }}>
          <span className="small muted tabular">
            {t("issues.createdBy", { number: i.number, name: actors.name(i.createdBy) })}
            {from && <> {from}</>}
          </span>
          <h1 className="page-title">{i.title}</h1>
        </header>
        <section aria-label={t("issues.description")}>
          <p className="issue-description">
            {i.description || <span className="muted">{t("issues.noDescription")}</span>}
          </p>
        </section>
        <section aria-labelledby="crit" className="issue-panel">
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <h2 id="crit" className="issue-panel__title">
              {t("issues.criteria")}
            </h2>
            {i.criteria.length > 0 && (
              <span className="small muted tabular">
                {t("issues.criteriaCount", { done, total: i.criteria.length })}
              </span>
            )}
          </div>
          {i.criteria.length === 0 && <p className="small muted">{t("issues.noCriteria")}</p>}
          {i.criteria.map((c) => (
            <div key={c.id} className="issue-criterion" data-done={c.done || undefined}>
              <Checkbox
                id={`crit-${c.id}`}
                checked={c.done}
                onCheckedChange={(v) => action.mutate({ type: "criterion", id: i.id, criterionId: c.id, done: v })}
              />
              <label htmlFor={`crit-${c.id}`}>{c.text}</label>
            </div>
          ))}
        </section>
        {i.assignee?.type !== "agent" && <AskAgent issue={i} />}
        <Activity issue={i} />
      </div>
      <Details issue={i} />
    </div>
  );
}

/** The agent offered by "Pedir à …": a developer when there is one. */
function useSuggestedAgent() {
  const { dir } = useActors();
  return dir.agents.find((a) => /dev|engenh|program|cód/i.test(`${a.role} ${a.name}`)) ?? dir.agents[0];
}

function AskAgent({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const { avatar } = useActors();
  const agent = useSuggestedAgent();
  if (!agent) return null;
  const g = agentGrammar(t, agent.name);
  return (
    <section aria-label={t("issues.askSection")} className="issue-ask">
      {avatar({ type: "agent", id: agent.id }, "sm")}
      <span className="issue-ask__text">
        <b>{t("issues.askTitle", { to: g.to, name: agent.name })}</b>
        <span className="small muted">{t("issues.askText", { The: g.The, name: agent.name })}</span>
      </span>
      <Button
        variant="agent"
        icon="agent"
        disabled={action.isPending}
        onClick={() =>
          action.mutate(
            { type: "ask", id: issue.id, agentId: agent.id },
            { onSuccess: () => toast.show(t("issues.asked", { The: g.The, name: agent.name })) },
          )
        }
      >
        {t("issues.askButton", { to: g.to, name: agent.name })}
      </Button>
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
  // The backend writes the event in words ("pediu a Ada para implementar").
  const eventText = (a: IssueActivity) => a.text;
  const list = activity.data ?? [];
  return (
    <section aria-labelledby="act" className="stack-4" style={{ gap: 4 }}>
      <h2 id="act" className="issue-panel__title" style={{ marginBottom: 8 }}>
        {t("issues.activity")}
      </h2>
      {activity.isSuccess && list.length === 0 && <p className="small muted">{t("issues.noActivity")}</p>}
      {list.map((a) =>
        a.kind === "event" ? (
          <div key={a.id} className="issue-event small muted">
            <Icon name={a.event === "agent_asked" ? "agent" : "waiting"} size={16} />
            <span>
              <b className="issue-event__who">{actors.name(a.author)}</b> {eventText(a)} ·{" "}
              {whenAt(t, i18n.language, a.createdAt)}
            </span>
          </div>
        ) : (
          <Message
            key={a.id}
            agent={a.author.type === "agent"}
            avatar={
              <Avatar
                kind={a.author.type}
                name={actors.name(a.author)}
                initials={a.author.type === "agent" ? actors.dir.agentInitials(a.author.id) : undefined}
                imageUrl={a.author.type === "person" ? actors.dir.memberById.get(a.author.id)?.image : undefined}
              />
            }
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

function Details({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const viewer = useArtifactViewer();
  return (
    <aside aria-label={t("issues.details")} className="issue-aside">
      <Field label={t("issues.statusLabel")} id="is-status">
        <Select
          size="sm"
          value={i.status}
          onValueChange={(v) => action.mutate({ type: "update", id: i.id, patch: { status: v as IssueStatus } })}
          options={STATUSES.map((s) => ({ value: s, label: t(`issues.status.${s}`) }))}
        />
      </Field>
      <Field label={t("issues.form.assignee")} id="is-who">
        <Select
          size="sm"
          value={actorKey(i.assignee)}
          onValueChange={(v) => action.mutate({ type: "update", id: i.id, patch: { assignee: actorFromKey(v) } })}
          options={actors.options(true)}
        />
      </Field>
      <Field label={t("issues.form.priority")} id="is-pri">
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
    </aside>
  );
}
