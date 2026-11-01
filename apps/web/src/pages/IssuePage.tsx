import type { Issue, IssuePriority } from "@agenteschat/client";
import {
  keys,
  useChannels,
  useIssue,
  useIssueAction,
  useIssueActivity,
  useIssueColumns,
  useWikiTree,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { relativeTime, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { webUrl } from "@agenteschat/client/lib/guards";
import { issueEventText } from "@agenteschat/client/lib/issues";
import { foldSteps } from "@agenteschat/client/lib/work";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Composer,
  type ComposerFormatLabels,
  CriteriaPixels,
  cx,
  DatePicker,
  DetailsDialog,
  DetailsSection,
  Field,
  FORMAT_KINDS,
  type FormatKind,
  Icon,
  Message,
  MessageText,
  Select,
  WorkSweep,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, useActors } from "@/components/actors";
import { useArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { IssueForumCard, NewTopicDialog } from "@/components/Forum";
import { useOrg } from "@/components/org-context";
import { useEmojiLabels } from "@/components/Reactions";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { useComposerFiles } from "@/hooks/useComposerFiles";
import { useMentionSearch } from "@/hooks/useMentionSearch";
import {
  columnIdOf,
  columnsOf,
  isOpen,
  PRIORITIES,
  STATUS_ICON,
  STATUSES,
  useAssigneeColor,
  useColumnTitle,
  useStageName,
  useStepText,
} from "@/lib/issues";
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

/** Where an issue came from: "a partir de uma mensagem no #eng" (a link), the forum, an agent, a webhook. */
function useIssueSource(i: Issue) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
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
}

/**
 * An issue opened from the board or the list: the shared details dialog
 * ("#131", the title, who made it and from where; "abrir em página própria").
 */
export function IssueDialog({ issue: i, onClose }: { issue: Issue; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const from = useIssueSource(i);
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("issues.close")}
      eyebrow={<span className="tabular">#{i.number}</span>}
      title={i.title}
      subtitle={
        <span>
          {t("issues.createdByShort", { name: actors.name(i.createdBy) })}
          {from && <> {from}</>}
        </span>
      }
      page={{
        label: t("issues.openPage"),
        render: (props) => (
          <Link to="/org/$orgId/issues/$number" params={{ orgId: org.id, number: String(i.number) }} {...props} />
        ),
      }}
    >
      <IssueDetails issue={i} variant="dialog" />
    </DetailsDialog>
  );
}

/**
 * An issue's details: source, status and who, the agent's
 * work (live steps, or "stalled" with "Pedir para continuar"), "Pedir a um
 * agente", description, criteria (who checked them), links and activity.
 * The page has its own header and aside; the dialog shows the fields on top.
 */
export function IssueDetails({ issue: i, variant }: { issue: Issue; variant: "page" | "dialog" }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const wikiLink = useWikiLinkRenderer();
  const action = useIssueAction(org.id);
  const color = useAssigneeColor();
  const done = i.criteria.filter((c) => c.done).length;
  const from = useIssueSource(i);
  const main = (
    <>
      {variant === "page" && (
        <header className="issue-details__head">
          <span className="small muted tabular">
            {t("issues.createdBy", { number: i.number, name: actors.name(i.createdBy) })}
            {from && <> {from}</>}
          </span>
          <h1 className="issue-details__title">{i.title}</h1>
        </header>
      )}
      {variant === "dialog" && <Details issue={i} />}
      <WorkBox issue={i} />
      {i.assignee?.type !== "agent" && isOpen(i) && <AskAgent issue={i} />}
      <DetailsSection title={t("issues.description")}>
        {i.description ? (
          <div className="issue-description">
            <Markdown source={i.description} variant="message" wikiLink={wikiLink} />
          </div>
        ) : (
          <p className="small muted">{t("issues.noDescription")}</p>
        )}
      </DetailsSection>
      <DetailsSection
        title={t("issues.criteria")}
        actions={
          i.criteria.length > 0 ? (
            <span className="issue-details__count tabular">
              {t("issues.criteriaCount", { done, total: i.criteria.length })}
            </span>
          ) : undefined
        }
      >
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
      </DetailsSection>
      <IssueForum issue={i} />
      {variant === "dialog" && (
        <DetailsSection title={t("issues.links")}>
          <Links issue={i} bare />
        </DetailsSection>
      )}
      <Activity issue={i} />
    </>
  );
  if (variant === "dialog") return main;
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

/**
 * The forum around an issue: its sub-issues, the topics that evaluate
 * it ("Em avaliação no fórum" / "Avaliado", with the mini track) and, while
 * open, "Avaliar no fórum" (the new-topic dialog, prefilled, format plan).
 */
function IssueForum({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const [evaluating, setEvaluating] = useState(false);
  const subs = i.subIssues ?? [];
  const topics = i.forumTopics ?? [];
  const requester = i.createdBy.type === "person" ? i.createdBy.id : null;
  const requesterName = requester ? actors.name(i.createdBy) : "";
  const g = agentGrammar(t, requesterName);
  const originText = requester
    ? t("forum.origin.issueBy", { number: i.number, name: requesterName, of: g.of })
    : t("forum.origin.issue", { number: i.number });
  const going = topics.some((x) => x.status === "open" || x.status === "stalled");
  if (subs.length === 0 && topics.length === 0 && !isOpen(i)) return null;
  return (
    <>
      {subs.length > 0 && (
        <DetailsSection title={t("forum.issue.subIssues", { count: subs.length })}>
          <ul className="forum-subl">
            {subs.map((s) => (
              <li key={s.id}>
                <Link to="/org/$orgId/issues/$number" params={{ orgId: org.id, number: String(s.number) }}>
                  <span className="forum-subl__num">#{s.number}</span>
                  <span className="forum-subl__tx">{s.title}</span>
                  {s.assignee && (
                    <span className="forum-subl__who">
                      <ActorAvatar actor={s.assignee} name={actors.name(s.assignee)} size="xs" />
                      {actors.name(s.assignee)}
                    </span>
                  )}
                  <Chip icon={STATUS_ICON[s.status]}>{t(`issues.status.${s.status}`)}</Chip>
                </Link>
              </li>
            ))}
          </ul>
        </DetailsSection>
      )}
      {(topics.length > 0 || (isOpen(i) && !going)) && (
        <DetailsSection title={t("forum.issue.section")}>
          {topics.map((x) => (
            <IssueForumCard key={x.id} topicId={x.id} />
          ))}
          {isOpen(i) && !going && (
            <div className="forum-evaluate">
              <span className="forum-evaluate__t">
                <b>
                  <Icon name="message" size={16} />
                  {t("forum.issue.evaluateTitle")}
                </b>
                <small>{t("forum.issue.evaluateText")}</small>
              </span>
              <Button size="sm" variant="primary" icon="message" onClick={() => setEvaluating(true)}>
                {t("forum.issue.evaluate")}
              </Button>
            </div>
          )}
        </DetailsSection>
      )}
      <NewTopicDialog
        open={evaluating}
        onClose={() => setEvaluating(false)}
        preset={{
          title: i.title,
          goal: i.description.trim().slice(0, 1000),
          format: "plan",
          rounds: 2,
          agentIds: i.assignee?.type === "agent" ? [i.assignee.id] : [],
          userIds: requester ? [requester] : [],
          originIssueId: i.id,
          originText,
          heading: "fromIssue",
        }}
      />
    </>
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
  const lines = foldSteps(w.steps, stepText);
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
        lines.length > 0 && (
          <ol className="issue-work__steps">
            {lines.map(({ step: s, text, count }, k) => {
              const current = k === lines.length - 1;
              return (
                <li key={`${s.at}-${s.tool}`} className={cx(current && "is-current")}>
                  <span className="issue-work__dot" aria-hidden="true">
                    <Icon name={s.outcome === "refused" ? "close" : current ? "play" : "check"} size={14} />
                  </span>
                  <span>{count > 1 ? `${text} ${t("chat.work.times", { count })}` : text}</span>
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

/** The agents offered by "Pedir a um agente", the ones that answer me (as the server asks): a developer first. */
function useAgentChoices() {
  const { dir } = useActors();
  const agents = dir.agents.filter(canTalk);
  const dev = agents.find((a) => /dev|engenh|program|cód/i.test(`${a.role} ${a.name}`)) ?? agents[0];
  return dev ? [dev, ...agents.filter((a) => a.id !== dev.id)] : [];
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
          <span className="small muted">{t("issues.askText", g)}</span>
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
  const { org, me } = useOrg();
  const activity = useIssueActivity(org.id, issue.id);
  const action = useIssueAction(org.id);
  const actors = useActors();
  const [text, setText] = useState("");
  const mentionSearch = useMentionSearch();
  const wikiLink = useWikiLinkRenderer();
  const viewer = useArtifactViewer();
  const wikiPages = useWikiTree(org.id);
  const box = useRef<HTMLTextAreaElement>(null);
  // The same box as the chat: formatting, emoji, wiki links and files (to the issue's channel Drive).
  const files = useComposerFiles(issue.channelId, () => box.current?.focus());
  const emojiPicker = useEmojiLabels();
  const emoji = useMemo(() => ({ ...emojiPicker, button: t("channel.emoji") }), [emojiPicker, t]);
  const format: ComposerFormatLabels = useMemo(
    () => ({
      ...(Object.fromEntries(FORMAT_KINDS.map((k) => [k, t(`composer.format.${k}`)])) as Record<FormatKind, string>),
      toolbar: t("composer.format.toolbar"),
      linkText: t("composer.format.linkText"),
    }),
    [t],
  );
  const list = activity.data ?? [];
  return (
    <DetailsSection title={t("issues.activity")}>
      {activity.isSuccess && list.length === 0 && <p className="small muted">{t("issues.noActivity")}</p>}
      {list.map((a) =>
        a.kind === "event" ? (
          <div key={a.id} className="issue-event small muted">
            <Icon
              name={a.event === "agent_asked" ? "agent" : a.textCode?.startsWith("forum_") ? "message" : "waiting"}
              size={16}
            />
            <span>
              <b className="issue-event__who">{actors.name(a.author)}</b> {issueEventText(t, a)}
              {a.auto && (
                <Chip icon="repeat" className="issue-event__auto" title={t("issues.autoHint")}>
                  {t("issues.auto")}
                </Chip>
              )}{" "}
              · {whenAt(t, i18n.language, a.createdAt)}
              {/* Asked an agent to implement it: the work conversation is in the asker's DM (only they open it). */}
              {a.event === "agent_asked" && a.textParams?.threadId && a.author.id === me.user.id && (
                <>
                  {" · "}
                  <Link
                    to="/org/$orgId/threads/$threadId"
                    params={{ orgId: org.id, threadId: a.textParams.threadId }}
                    className="ac-link"
                  >
                    {t("issues.openConversation")}
                  </Link>
                </>
              )}
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
            {a.text && (
              <MessageText>
                <Markdown source={a.text} variant="message" wikiLink={wikiLink} />
              </MessageText>
            )}
            {a.attachments && a.attachments.length > 0 && (
              <span className="issue-comment__files">
                {a.attachments.map((f) => (
                  <button key={f.id} type="button" className="issue-link" onClick={() => viewer.open(f.id)}>
                    <Icon name="attach" size={16} />
                    {f.title}
                  </button>
                ))}
              </span>
            )}
          </Message>
        ),
      )}
      <Composer
        value={text}
        onChange={setText}
        textareaRef={box}
        label={t("issues.comment")}
        placeholder={t("issues.commentPlaceholder")}
        sendLabel={t("issues.send")}
        sendText={t("issues.send")}
        attachLabel={t("channel.attach")}
        format={format}
        emoji={emoji}
        attachments={files.attachments}
        onFiles={files.onFiles}
        canSendEmpty={files.attached.length > 0}
        sendBlocked={files.uploading}
        mentions={{ search: mentionSearch, listLabel: t("mentions.list") }}
        links={{
          listLabel: t("wiki.editor.suggest"),
          search: (q) =>
            (wikiPages.data ?? [])
              .filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()))
              .slice(0, 8)
              .map((p) => ({
                key: `wiki:${p.slug}`,
                insert: p.title,
                label: p.title,
                description: p.folder || undefined,
                leading: <Icon name="book" size={16} />,
              })),
        }}
        disabled={action.isPending}
        onSend={(body) => {
          if (files.uploading || (!body && files.attached.length === 0)) return;
          action.mutate(
            { type: "comment", id: issue.id, text: body, attachmentIds: files.attached.map((f) => f.id) },
            {
              onSuccess: () => {
                setText("");
                files.clear();
              },
            },
          );
        }}
      />
    </DetailsSection>
  );
}

/** Status, who, priority and due date (the page's aside; at the top of the panel). */
function Details({ issue: i, bare = false }: { issue: Issue; bare?: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const columns = useIssueColumns(org.id).data ?? [];
  const title = useColumnTitle();
  const stageName = useStageName();
  // The column picker: every column, grouped by stage (also the keyboard way to move a card).
  const columnOptions = STATUSES.flatMap((s) =>
    columnsOf(columns, s).map((c) => ({
      value: c.id,
      label: title(c),
      group: stageName(s),
      leading: <Icon name={STATUS_ICON[s]} size={16} />,
    })),
  );
  const fields = (
    <>
      <Field label={t("issues.column")} id={`is-col-${i.id}`}>
        <Select
          size="sm"
          value={columnIdOf(i, columns) ?? undefined}
          onValueChange={(v) =>
            action.mutate({ type: "update", id: i.id, patch: { columnId: v, boardRank: -Date.now() } })
          }
          options={columnOptions}
        />
      </Field>
      <Field label={t("issues.form.assignee")} id={`is-who-${i.id}`}>
        <Select
          size="sm"
          value={actorKey(i.assignee)}
          onValueChange={(v) => action.mutate({ type: "update", id: i.id, patch: { assignee: actorFromKey(v) } })}
          options={actors.options(true, actorKey(i.assignee))}
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
      <Field label={t("issues.due")} id={`is-due-${i.id}`}>
        <DatePicker
          size="sm"
          value={i.dueDate}
          onChange={(v) => action.mutate({ type: "update", id: i.id, patch: { dueDate: v } })}
          onClear={() => action.mutate({ type: "update", id: i.id, patch: { dueDate: null } })}
          placeholder={t("issues.noDue")}
          locale={i18n.language}
          labels={{
            previousMonth: t("common.previousMonth"),
            nextMonth: t("common.nextMonth"),
            choose: t("common.chooseDate"),
            clear: t("issues.removeDue"),
          }}
        />
        {i.dueDate && (
          <Link to="/org/$orgId/calendar" params={{ orgId: org.id }} className="ac-link small issue-due__link">
            {t("issues.seeCalendar")}
          </Link>
        )}
      </Field>
      <p className="issue-flow-hint">{t("issues.flowHint")}</p>
    </>
  );
  if (bare) return fields;
  return (
    <aside aria-label={t("issues.details")} className="issue-props">
      {fields}
    </aside>
  );
}

/** Pull requests, files and labels. `bare`: inside a section that already says "Links". */
function Links({ issue: i, bare = false }: { issue: Issue; bare?: boolean }) {
  const { t } = useTranslation();
  const actors = useActors();
  const viewer = useArtifactViewer();
  return (
    <>
      <div className="issue-aside__item">
        {!bare && <span className="ac-field__label">{t("issues.links")}</span>}
        {i.pullRequests.length + i.artifacts.length === 0 && <span className="small muted">{t("issues.noLinks")}</span>}
        {i.pullRequests.map((pr) => (
          <a key={pr.number} href={webUrl(pr.url)} target="_blank" rel="noopener noreferrer" className="issue-link">
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
