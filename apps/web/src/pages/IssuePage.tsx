import type { Issue, IssueActivity, IssuePriority } from "@agenteschat/client";
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
  SavedNote,
  Select,
  TabPanel,
  Tabs,
  WorkSweep,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, useActors } from "@/components/actors";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { IssueWorkBlock } from "@/components/BackgroundWork";
import { EditInPlace, useFocusAtEnd, useSavedFlash, useSent } from "@/components/EditInPlace";
import { IssueForumCard, NewTopicDialog } from "@/components/Forum";
import { IssueFiles, useIssueFileEntries } from "@/components/IssueFiles";
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
import { useIssueRealtime } from "@/realtime/context";
import "./issues.css";

/** One issue as a page (`/issues/131`); the board opens the same details in its panel. */
export function IssuePage({ number }: { number: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const issue = useIssue(org.id, number);
  return (
    <div className="page page--full">
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
 * An issue opened from the board or the list: the task's own page inside the shared details dialog ("#131" and its
 * title on its bar, which never scrolls away; "abrir em página própria"), wide and always full height so changing
 * tabs never makes it jump.
 */
export function IssueDialog({ issue: i, onClose }: { issue: Issue; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("issues.close")}
      size="lg"
      fill
      titleHidden
      eyebrow={<IssueBarTitle issue={i} />}
      title={i.title}
      // Esc in a text being edited in place saves it and stays: the dialog closes on the next Esc.
      onEscapeKeyDown={(e) => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el.closest("[data-inplace]")) {
          e.preventDefault();
          el.blur();
        }
      }}
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

/** "#131 Confirmação do agendamento por WhatsApp" on the dialog's bar, the title edited in place there. */
function IssueBarTitle({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const [saved, flashSaved] = useSavedFlash();
  return (
    <div className="issue-bartitle">
      <span className="issue-bartitle__number tabular">#{i.number}</span>
      <IssueTitle issue={i} onSaved={flashSaved} />
      <SavedNote shown={saved} label={t("common.saved")} className="issue-bartitle__saved" />
    </div>
  );
}

/**
 * An issue's details, the same on its page and in the dialog (whose bar has the title): who made it and from where, the title, then tabs
 * (the agent's work, live steps or "stalled" with "Pedir para continuar"; "Pedir a um agente"; description,
 * criteria and who checked them; forum; discussion), and the aside with its fields and links. The title, the
 * description and the criteria are edited where they are, saved on leaving the field ("Salvo" by the source line).
 */
export function IssueDetails({ issue: i, variant }: { issue: Issue; variant: "page" | "dialog" }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const from = useIssueSource(i);
  const activity = useIssueActivity(org.id, i.id);
  // Comments, files and events arrive live while it's open (every tab reads this one list).
  useIssueRealtime(org.id, i);
  const list = activity.data ?? [];
  const [tab, setTab] = useState<"details" | "files" | "history">("details");
  const files = useIssueFileEntries(i, list);
  const [saved, flashSaved] = useSavedFlash();
  // The files it was created with show under the description (prints, logs): the rest are in "Anexos".
  const createdFiles = list.find((a) => a.event === "created")?.attachments ?? [];
  return (
    <div className="issue-layout">
      <div className="issue-details issue-layout__main">
        <header className="issue-details__head">
          <span className="small muted tabular">
            {variant === "page"
              ? t("issues.createdBy", { number: i.number, name: actors.name(i.createdBy) })
              : t("issues.createdByShort", { name: actors.name(i.createdBy) })}
            {from && <> {from}</>}
            <SavedNote shown={saved} label={t("common.saved")} className="issue-details__saved" />
          </span>
          {variant === "page" && <IssueTitle issue={i} onSaved={flashSaved} />}
        </header>
        <Tabs
          value={tab}
          onValueChange={setTab}
          label={t("issues.tabs.label")}
          items={[
            { value: "details", label: t("issues.tabs.details") },
            { value: "files", label: t("issues.tabs.files"), count: files.length || undefined },
            { value: "history", label: t("issues.tabs.history") },
          ]}
        >
          <TabPanel value="details">
            <WorkBox issue={i} />
            <IssueWorkBlock issue={i} />
            {i.assignee?.type !== "agent" && isOpen(i) && <AskAgent issue={i} />}
            <DetailsSection title={t("issues.description")}>
              <IssueDescription issue={i} hasFiles={createdFiles.length > 0} onSaved={flashSaved} />
              {createdFiles.length > 0 && (
                <div className="artifact-cards issue-description__files">
                  {createdFiles.map((f) => (
                    <ArtifactCard key={f.id} artifact={{ id: f.id }} />
                  ))}
                </div>
              )}
            </DetailsSection>
            <IssueCriteria issue={i} onSaved={flashSaved} />
            <IssueForum issue={i} />
            <Discussion issue={i} activity={list} loaded={activity.isSuccess} />
          </TabPanel>
          <TabPanel value="files">
            <IssueFiles issue={i} activity={list} />
          </TabPanel>
          <TabPanel value="history">
            <History activity={list} loaded={activity.isSuccess} />
          </TabPanel>
        </Tabs>
      </div>
      <aside aria-label={t("issues.details")} className="issue-aside">
        <Details issue={i} />
        <Links issue={i} />
      </aside>
    </div>
  );
}

/** The title, edited in place: Enter, Esc or leaving the field saves it (an empty one keeps the old title). */
function IssueTitle({ issue: i, onSaved }: { issue: Issue; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useSent<string>(i.title);
  const title = sent.pending ?? i.title;
  const ref = useFocusAtEnd<HTMLInputElement>(draft !== null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (!next || next === title) return;
    sent.send(next);
    action.mutate({ type: "update", id: i.id, patch: { title: next } }, { onSuccess: onSaved, onError: sent.clear });
  };
  if (draft !== null)
    return (
      <input
        ref={ref}
        className="issue-inplace__title"
        value={draft}
        maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
        aria-label={t("issues.form.title")}
        data-inplace=""
      />
    );
  return (
    <EditInPlace label={t("issues.edit.title")} onEdit={() => setDraft(title)}>
      <h1 className="issue-details__title">{title}</h1>
    </EditInPlace>
  );
}

/** The description, edited in place in the creation's box: leaving it, Esc or ⌘↵ saves it. */
function IssueDescription({ issue: i, hasFiles, onSaved }: { issue: Issue; hasFiles: boolean; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const wikiLink = useWikiLinkRenderer();
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useSent<string>(i.description);
  const description = sent.pending ?? i.description;
  const ref = useFocusAtEnd<HTMLTextAreaElement>(draft !== null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next === description.trim()) return;
    sent.send(next);
    action.mutate(
      { type: "update", id: i.id, patch: { description: next } },
      { onSuccess: onSaved, onError: sent.clear },
    );
  };
  if (draft !== null)
    return (
      <>
        <div className="issue-new__editor" data-inplace="">
          <textarea
            ref={ref}
            className="issue-new__text"
            rows={4}
            value={draft}
            maxLength={50_000}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key !== "Escape" && !(e.key === "Enter" && (e.metaKey || e.ctrlKey))) return;
              e.preventDefault();
              e.currentTarget.blur();
            }}
            placeholder={t("issues.form.descriptionPlaceholder")}
            aria-label={t("issues.description")}
          />
        </div>
        <p className="issue-new__hint small muted">{t("issues.edit.hint")}</p>
      </>
    );
  return (
    <EditInPlace label={t("issues.edit.description")} onEdit={() => setDraft(description)}>
      {description ? (
        <div className="issue-description">
          <Markdown source={description} variant="message" wikiLink={wikiLink} />
        </div>
      ) : (
        // With the files it was created with and no text, the files say it all; the pencil still opens the box.
        !hasFiles && <p className="small muted">{t("issues.noDescription")}</p>
      )}
    </EditInPlace>
  );
}

/**
 * Acceptance criteria: checked as before, and edited where they are: the pencil on a row turns it into a field
 * (an empty one removes it), "Adicionar critério" at the end adds one. The whole list goes to the server at once.
 */
function IssueCriteria({ issue: i, onSaved }: { issue: Issue; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const color = useAssigneeColor();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = useState("");
  const ref = useFocusAtEnd<HTMLInputElement>(editing !== null);
  // What was just sent shows until the task comes back with it; a new one has no id yet.
  const sent = useSent<{ id?: string; text: string }[]>(i.criteria.map((c) => `${c.id}:${c.text}`).join("\n"));
  const shown = sent.pending
    ? sent.pending.map((c, k) => {
        const kept = i.criteria.find((x) => x.id === c.id);
        return { id: c.id ?? `new-${k}`, text: c.text, done: kept?.done ?? false, doneBy: kept?.doneBy ?? null };
      })
    : i.criteria;
  const done = shown.filter((c) => c.done).length;
  const saveList = (list: { id?: string; text: string }[]) => {
    sent.send(list);
    action.mutate({ type: "update", id: i.id, patch: { criteria: list } }, { onSuccess: onSaved, onError: sent.clear });
  };
  const current = shown.map((c) => (c.id.startsWith("new-") ? { text: c.text } : { id: c.id, text: c.text }));
  const commit = () => {
    if (!editing) return;
    const { id, text } = editing;
    setEditing(null);
    const next = text.trim();
    if (next === shown.find((c) => c.id === id)?.text) return;
    saveList(next ? current.map((c) => (c.id === id ? { id, text: next } : c)) : current.filter((c) => c.id !== id));
  };
  const remove = (id: string) => {
    setEditing(null);
    saveList(current.filter((c) => c.id !== id));
  };
  const add = () => {
    const text = adding.trim();
    if (!text) return;
    setAdding("");
    saveList([...current, { text }]);
  };
  return (
    <DetailsSection
      title={t("issues.criteria")}
      actions={
        shown.length > 0 ? (
          <span className="issue-details__count tabular">
            {t("issues.criteriaCount", { done, total: shown.length })}
          </span>
        ) : undefined
      }
    >
      {shown.length > 0 && <CriteriaPixels done={shown.map((c) => c.done)} color={color(i)} />}
      {shown.map((c) =>
        editing?.id === c.id ? (
          <div key={c.id} className="issue-new__criterion issue-criterion--edit" data-inplace="">
            <span className="issue-new__box" aria-hidden="true" />
            <input
              ref={ref}
              value={editing.text}
              maxLength={500}
              onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== "Escape") return;
                e.preventDefault();
                e.currentTarget.blur();
              }}
              aria-label={t("issues.criteria")}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              aria-label={t("issues.form.removeCriterion")}
              title={t("issues.form.removeCriterion")}
              // Keeps the field focused, so leaving it doesn't save the row first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => remove(c.id)}
            />
          </div>
        ) : (
          <div key={c.id} className="issue-criterion" data-done={c.done || undefined}>
            <Checkbox
              id={`crit-${c.id}`}
              checked={c.done}
              disabled={c.id.startsWith("new-")}
              onCheckedChange={(v) => action.mutate({ type: "criterion", id: i.id, criterionId: c.id, done: v })}
            />
            <label htmlFor={`crit-${c.id}`}>{c.text}</label>
            {c.done && c.doneBy?.type === "agent" && (
              <span className="issue-criterion__by" title={t("issues.checkedBy", { name: actors.name(c.doneBy) })}>
                <ActorAvatar actor={c.doneBy} name={actors.name(c.doneBy)} size="xs" />
                {actors.name(c.doneBy)}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="edit"
              aria-label={t("issues.edit.criterion", { text: c.text })}
              title={t("issues.edit.criterionShort")}
              className="issue-criterion__pen"
              disabled={c.id.startsWith("new-")}
              onClick={() => setEditing({ id: c.id, text: c.text })}
            />
          </div>
        ),
      )}
      <div className="issue-new__criterion issue-new__criterion--add" data-inplace="">
        <Icon name="plus" size={16} />
        <input
          value={adding}
          maxLength={500}
          onChange={(e) => setAdding(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
          placeholder={t("issues.form.addCriterion")}
          aria-label={t("issues.form.addCriterion")}
        />
      </div>
    </DetailsSection>
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
  const g = agentGrammar(requesterName);
  const originText = requester
    ? t("forum.origin.issueBy", { number: i.number, name: requesterName, context: g.context })
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
  const g = agentGrammar(name);
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
    const g = agentGrammar(a.name);
    action.mutate(
      { type: "ask", id: issue.id, agentId: a.id },
      { onSuccess: () => toast.show(t("issues.asked", { context: g.context, name: a.name })) },
    );
  };
  const g = agentGrammar(agent.name);
  return (
    <section aria-label={t("issues.askSection")} className="issue-ask">
      <div className="issue-ask__row">
        {avatar({ type: "agent", id: agent.id }, "sm")}
        <span className="issue-ask__text">
          <b>{t("issues.askTitle", { context: g.context, name: agent.name })}</b>
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
          {t("issues.askButton", { context: g.context, name: agent.name })}
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

/**
 * "Discussão": the box on top and the comments under it, newest first. Comments carry their files the way chat
 * messages do (a print as its thumbnail, a click opens it; other files as a card); a print pastes into the box.
 */
function Discussion({ issue, activity, loaded }: { issue: Issue; activity: IssueActivity[]; loaded: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const actors = useActors();
  const [text, setText] = useState("");
  const mentionSearch = useMentionSearch();
  const wikiLink = useWikiLinkRenderer();
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
  const comments = activity.filter((a) => a.kind === "comment").reverse();
  return (
    <DetailsSection title={t("issues.discussion")} count={comments.length || undefined}>
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
      {loaded && comments.length === 0 && <p className="small muted">{t("issues.noComments")}</p>}
      {comments.map((a) => (
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
            <div className="artifact-cards">
              {a.attachments.map((f) => (
                <ArtifactCard key={f.id} artifact={{ id: f.id }} />
              ))}
            </div>
          )}
        </Message>
      ))}
    </DetailsSection>
  );
}

/** "Histórico": what happened to the task, oldest first: its events and a line for each comment. */
function History({ activity, loaded }: { activity: IssueActivity[]; loaded: boolean }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const actors = useActors();
  return (
    <section className="issue-history" aria-label={t("issues.tabs.history")}>
      {loaded && activity.length === 0 && <p className="small muted">{t("issues.noActivity")}</p>}
      {activity.map((a) =>
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
          <div key={a.id} className="issue-event small muted">
            <Icon name="message" size={16} />
            <span>
              <b className="issue-event__who">{actors.name(a.author)}</b>{" "}
              {t(a.attachments?.length ? "issues.history.commentedFiles" : "issues.history.commented")} ·{" "}
              {whenAt(t, i18n.language, a.createdAt)}
            </span>
          </div>
        ),
      )}
    </section>
  );
}

/** Column, who, priority and due date, at the top of the aside (on the page and in the dialog). */
function Details({ issue: i }: { issue: Issue }) {
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
  return (
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
}

/** Pull requests and labels (files are in "Anexos"). */
function Links({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const actors = useActors();
  return (
    <>
      <div className="issue-aside__item">
        <span className="ac-field__label">{t("issues.links")}</span>
        {i.pullRequests.length === 0 && <span className="small muted">{t("issues.noLinks")}</span>}
        {i.pullRequests.map((pr) => (
          <a key={pr.number} href={webUrl(pr.url)} target="_blank" rel="noopener noreferrer" className="issue-link">
            <Icon name="pullRequest" size={16} />
            {pr.openedBy
              ? t("issues.prBy", { number: pr.number, name: actors.name(pr.openedBy) })
              : t("issues.pr", { number: pr.number })}
          </a>
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
