import type { ForumSuggestion, ForumTopicDetail, ForumTopicInput, Message } from "@agenteschat/client";
import { cacheForumSuggestion, useForumAction, useForumTopic } from "@agenteschat/client";
import { isEnded } from "@agenteschat/client/lib/forum";
import { Button, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { NewTopicDialog } from "./NewTopicDialog";
import { ForumStatusChip, TopicTrack, useForumWho } from "./pieces";
import "@/pages/forum.css";

/** The topic a chat message points at (`meta.forumTopic` / `meta.forumTopicId`), or null. */
export function forumTopicOfMessage(meta: Record<string, unknown> | undefined): string | null {
  const t = meta?.forumTopic as { id?: unknown } | undefined;
  if (t && typeof t.id === "string") return t.id;
  return typeof meta?.forumTopicId === "string" ? meta.forumTopicId : null;
}

/** An agent's "Vale um fórum?" (`meta.forumSuggestion`), or null. */
export function forumSuggestionOf(meta: Record<string, unknown> | undefined): ForumSuggestion | null {
  const s = meta?.forumSuggestion as Partial<ForumSuggestion> | undefined;
  return s && typeof s.title === "string" && Array.isArray(s.agentIds) && typeof s.state === "string"
    ? (s as ForumSuggestion)
    : null;
}

/** "rodada 2 de 3" / "3 rodadas". */
function useRoundText() {
  const { t } = useTranslation();
  return (tp: ForumTopicDetail) =>
    isEnded(tp)
      ? t("forum.rounds", { count: Math.max(1, tp.round) })
      : t("forum.roundOf", { round: Math.max(1, tp.round), rounds: tp.rounds });
}

/** A topic as a card (chat, issue): status, the round, the mini track and "Ver discussão". */
function TopicCardBody({ topic }: { topic: ForumTopicDetail }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const round = useRoundText();
  return (
    <div className="forum-sugc__f">
      <ForumStatusChip topic={topic} />
      <span className="forum-sugc__round">{round(topic)}</span>
      <TopicTrack topic={topic} size="mid" />
      <span className="forum-grow" />
      <Button asChild size="sm">
        <Link to="/org/$orgId/forum/$topicId" params={{ orgId: org.id, topicId: topic.id }}>
          {t("forum.card.see")}
          <Icon name="chevronRight" size={16} />
        </Link>
      </Button>
    </div>
  );
}

/** In a channel: the topic an agent opened (or the synthesis that came back), with the mini track. */
export function ForumMessageCard({ topicId }: { topicId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const topic = useForumTopic(org.id, topicId);
  if (!topic.data) return null;
  const tp = topic.data;
  return (
    <section className="forum-sugc" aria-label={t("forum.card.label")}>
      <div className="forum-sugc__h">
        <span className="forum-sugc__ic">
          <Icon name="message" size={16} />
        </span>
        <b>{t("forum.card.label")}</b>
      </div>
      <div className="forum-sugc__t">{tp.title}</div>
      <p className="forum-sugc__g">{tp.goal}</p>
      <TopicCardBody topic={tp} />
    </section>
  );
}

/** On an issue: the topic that evaluates it ("Em avaliação no fórum" / "Avaliado no fórum"). */
export function IssueForumCard({ topicId }: { topicId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const topic = useForumTopic(org.id, topicId);
  if (!topic.data) return null;
  const tp = topic.data;
  return (
    <section className="forum-sugc" aria-label={tp.title}>
      <div className="forum-sugc__h">
        <span className="forum-sugc__ic">
          <Icon name="message" size={16} />
        </span>
        <span>
          <b>{t(isEnded(tp) ? "forum.issue.evaluated" : "forum.issue.inForum")}</b>{" "}
          <span className="forum-sugc__sub">
            {t(tp.format === "plan" ? "forum.issue.outPlan" : "forum.issue.outDecision")}
          </span>
        </span>
      </div>
      <div className="forum-sugc__t">{tp.title}</div>
      <TopicCardBody topic={tp} />
    </section>
  );
}

const UNDO_MS = 6000;

/**
 * An agent's suggestion in the chat ("Vale um fórum?"): the question, the
 * table and the rounds; "Abrir fórum" (only a person opens it, in their
 * name), "Editar" (the new-topic dialog, prefilled) or "Agora não" (with a
 * few seconds to undo before it is dismissed). Live: accepted or dismissed
 * by anyone, the card follows (`forum.suggestion.updated`).
 */
export function ForumSuggestionCard({ message, suggestion }: { message: Message; suggestion: ForumSuggestion }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const action = useForumAction(org.id);
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const by = who.agentName(suggestion.suggestedByAgentId);
  const accepted = useForumTopic(org.id, suggestion.state === "accepted" ? suggestion.topicId : null);
  const save = (s: ForumSuggestion) => cacheForumSuggestion(qc, org.id, message.channelId, message.id, s);
  const dismissNow = () => {
    timer.current = null;
    action.mutate(
      { type: "dismiss", messageId: message.id },
      { onSuccess: (r) => save((r as { suggestion: ForumSuggestion }).suggestion), onSettled: () => setLeaving(false) },
    );
  };
  // Leaving the conversation during the undo window still dismisses it.
  const pending = useRef(dismissNow);
  pending.current = dismissNow;
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        pending.current();
      }
    },
    [],
  );
  const accept = (overrides?: ForumTopicInput) =>
    action.mutate(
      {
        type: "accept",
        messageId: message.id,
        overrides: overrides
          ? {
              title: overrides.title,
              goal: overrides.goal,
              agentIds: overrides.agentIds,
              userIds: overrides.userIds,
              rounds: overrides.rounds,
              format: overrides.format,
              ...(overrides.seats ? { seats: overrides.seats } : {}),
              ...(overrides.deadline ? { deadline: overrides.deadline } : {}),
            }
          : undefined,
      },
      {
        onSuccess: (r) => {
          const res = r as { topic: ForumTopicDetail; suggestion: ForumSuggestion };
          save(res.suggestion);
          setEditing(false);
          toast.show(t("forum.suggestion.openedToast"), "info", {
            label: t("forum.card.see"),
            run: () =>
              void navigate({ to: "/org/$orgId/forum/$topicId", params: { orgId: org.id, topicId: res.topic.id } }),
          });
        },
      },
    );

  if (suggestion.state === "accepted") {
    const tp = accepted.data;
    return (
      <section className="forum-sugc" aria-label={t("forum.suggestion.opened")}>
        <div className="forum-sugc__h">
          <span className="forum-sugc__ic">
            <Icon name="message" size={16} />
          </span>
          <span>
            <b>{t("forum.suggestion.opened")}</b>{" "}
            <span className="forum-sugc__sub">
              {t("forum.suggestion.openedBy", { name: who.personName(suggestion.decidedByUserId) })}
            </span>
          </span>
        </div>
        <div className="forum-sugc__t">{tp?.title ?? suggestion.title}</div>
        {tp && <TopicCardBody topic={tp} />}
      </section>
    );
  }
  if (suggestion.state === "dismissed")
    return (
      <p className="forum-sg-note ac-iconline">
        <Icon name="dash" size={14} />
        {suggestion.decidedByUserId === who.me
          ? t("forum.suggestion.dismissedMe")
          : t("forum.suggestion.dismissed", { name: who.personName(suggestion.decidedByUserId) })}
      </p>
    );
  if (leaving)
    return (
      <p className="forum-sg-note ac-iconline" role="status">
        <Icon name="dash" size={14} />
        {t("forum.suggestion.dismissedMe")}{" "}
        <button
          type="button"
          className="ac-link forum-vlink"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            setLeaving(false);
          }}
        >
          {t("forum.suggestion.undo")}
        </button>
      </p>
    );
  return (
    <>
      <section className="forum-sugc" aria-label={t("forum.suggestion.label")}>
        <div className="forum-sugc__h">
          <span className="forum-sugc__ic">
            <Icon name="message" size={16} />
          </span>
          <b>{t("forum.suggestion.title")}</b>
          <span className="forum-sugc__sub">{t("forum.suggestion.by", { name: by })}</span>
          <span className="forum-grow" />
          <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(true)}>
            {t("forum.suggestion.edit")}
          </Button>
        </div>
        <div className="forum-sugc__t">{suggestion.title}</div>
        <p className="forum-sugc__g">{suggestion.goal}</p>
        <div className="forum-sugc__m">
          <span className="forum-sugc__lb">{t("forum.suggestion.table")}</span>
          {suggestion.agentIds.map((id, i) => (
            <span key={id} className="forum-sugc__a">
              <span className="forum-sugc__no">{i + 1}</span>
              <AgentAvatar agentId={id} name={who.agentName(id)} size="xs" state="idle" />
              {who.agentName(id)}
            </span>
          ))}
          <span className="forum-sugc__r">
            <Icon name="message" size={14} />
            {t("forum.rounds", { count: suggestion.rounds })}
          </span>
        </div>
        <div className="forum-sugc__f">
          <Button
            variant="primary"
            size="sm"
            icon="message"
            loading={action.isPending && action.variables?.type === "accept"}
            disabled={action.isPending}
            onClick={() => accept()}
          >
            {t("forum.suggestion.open")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => {
              setLeaving(true);
              timer.current = setTimeout(() => pending.current(), UNDO_MS);
            }}
          >
            {t("forum.suggestion.notNow")}
          </Button>
        </div>
      </section>
      <p className="forum-sg-note ac-iconline">
        <Icon name="shield" size={14} />
        {t("forum.suggestion.note")}
      </p>
      <NewTopicDialog
        open={editing}
        onClose={() => setEditing(false)}
        preset={{
          title: suggestion.title,
          goal: suggestion.goal,
          agentIds: suggestion.agentIds,
          rounds: suggestion.rounds,
          format: suggestion.format,
          heading: "editSuggestion",
        }}
        busy={action.isPending}
        onSubmit={(input) => accept(input)}
      />
    </>
  );
}
