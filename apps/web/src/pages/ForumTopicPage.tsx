import { Avatar, Button, Composer, Dialog, DialogFooter, EmptyState, Menu, MenuItem, Steps } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForumAction, useForumTopic } from "@/api/queries";
import type { ForumPost, ForumTopicDetail } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import {
  CreateIssuesDialog,
  ForumParticipants,
  ForumStatusChip,
  ParticipantsDialog,
  useForumCost,
} from "@/components/Forum";
import { ErrorState, LoadingPage } from "@/components/Loading";
import { MessageWork } from "@/components/MessageWork";
import { useOrg } from "@/components/org-context";
import { SaveToWikiDialog } from "@/components/SaveToWiki";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { useDirectory } from "@/hooks/useDirectory";
import { formatTime, relativeTime } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { useChannelRealtime, useStreams } from "@/realtime/context";
import { agentStateIn } from "@/realtime/streams";

/** The closing post (`meta.synthesis`): shown with the synthesis, not in a round. */
export const isSynthesisPost = (p: ForumPost) => p.meta?.synthesis === true;

/**
 * Posts by round: [[0, posts]?, [1, posts], [2, posts]…], every round up to
 * the current one (even if still empty); round 0 (before round 1) only when
 * it has posts. The synthesis post is left out.
 */
export function postsByRound(topic: Pick<ForumTopicDetail, "posts" | "round">) {
  const rounds = new Map<number, ForumPost[]>();
  for (let r = 1; r <= Math.max(topic.round, 1); r++) rounds.set(r, []);
  const sorted = [...topic.posts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of sorted) {
    if (isSynthesisPost(p)) continue;
    rounds.set(p.round, [...(rounds.get(p.round) ?? []), p]);
  }
  return [...rounds.entries()].sort((a, b) => a[0] - b[0]);
}

/** A forum topic: header, the rounds with the agents' posts, live states, people's messages, the synthesis. */
export function ForumTopicPage({ topicId }: { topicId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const topic = useForumTopic(org.id, topicId);
  if (topic.isLoading) {
    return (
      <div className="page page--mid">
        <LoadingPage rows={4} />
      </div>
    );
  }
  if (!topic.data) {
    const notFound = (topic.error as { status?: number } | null)?.status === 404;
    return (
      <div className="page page--mid">
        {notFound ? (
          <EmptyState icon="message">{t("forum.notFound")}</EmptyState>
        ) : (
          <ErrorState error={topic.error} onRetry={() => void topic.refetch()} />
        )}
      </div>
    );
  }
  return <TopicView topic={topic.data} />;
}

function TopicView({ topic }: { topic: ForumTopicDetail }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const action = useForumAction(org.id);
  const cost = useForumCost();
  const wikiLink = useWikiLinkRenderer();
  const [draft, setDraft] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [issues, setIssues] = useState(false);
  // Live runs when the topic has its own channel (avatars think and write).
  useChannelRealtime(org.id, topic.channelId, topic.status === "open");
  const states = useStreams((s) => topic.agentIds.map((id) => agentStateIn(s, id, topic.channelId)).join(",")).split(
    ",",
  );
  const open = topic.status === "open";
  const live = open
    ? topic.agentIds
        .map((id, i) => ({
          id,
          name: dir.agentById.get(id)?.name ?? "",
          state:
            states[i] === "writing" || states[i] === "thinking"
              ? (states[i] as "writing" | "thinking")
              : topic.activeAgentIds?.includes(id)
                ? ("thinking" as const)
                : null,
        }))
        .filter((a) => a.state !== null)
    : [];
  const author = (p: ForumPost) =>
    p.author.type === "agent"
      ? (dir.agentById.get(p.author.id)?.name ?? "")
      : (dir.memberById.get(p.author.id)?.name ?? "");
  const creator =
    topic.createdBy.type === "agent"
      ? dir.agentById.get(topic.createdBy.id)?.name
      : dir.memberById.get(topic.createdBy.id)?.name;
  const suggested = topic.synthesis?.suggestedIssues ?? [];
  const closing = topic.posts.find(isSynthesisPost);
  const [editingPeople, setEditingPeople] = useState(false);
  const [savingWiki, setSavingWiki] = useState(false);

  return (
    <div className="page page--mid forum-topic">
      <Link to="/org/$orgId/forum" params={{ orgId: org.id }} className="forum-topic__back small muted">
        {t("forum.back")}
      </Link>
      <header className="forum-topic__head">
        <div className="stack-4" style={{ gap: 6, flex: "1 1 320px", minWidth: 0 }}>
          <h1 className="page-title">{topic.title}</h1>
          <p className="forum-topic__goal">{topic.goal}</p>
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <ForumParticipants topic={topic} max={8} />
            <ForumStatusChip topic={topic} />
            <span className="small muted tabular">{cost(topic)}</span>
            {creator && <span className="small muted">{t("forum.openedBy", { name: creator })}</span>}
          </div>
        </div>
        <div className="row forum-topic__actions" style={{ gap: 6 }}>
          {open && (
            <Button
              onClick={() =>
                action.mutate(
                  { type: "conclude", topicId: topic.id },
                  { onSuccess: () => toast.show(t("forum.concluded")) },
                )
              }
              loading={action.isPending && action.variables?.type === "conclude"}
              disabled={action.isPending}
            >
              {t("forum.conclude")}
            </Button>
          )}
          <Menu
            align="end"
            label={t("forum.more")}
            trigger={<Button variant="ghost" iconOnly icon="more" aria-label={t("forum.more")} />}
          >
            <MenuItem
              icon="link"
              onSelect={async () => {
                await navigator.clipboard?.writeText(window.location.href);
                toast.show(t("forum.linkCopied"));
              }}
            >
              {t("forum.copyLink")}
            </MenuItem>
            {open && (
              <MenuItem icon="members" onSelect={() => setEditingPeople(true)}>
                {t("forum.editParticipants")}
              </MenuItem>
            )}
            {open && (
              <MenuItem icon="block" danger onSelect={() => setCanceling(true)}>
                {t("forum.cancel")}
              </MenuItem>
            )}
          </Menu>
        </div>
      </header>
      {open && (
        <Steps
          current={Math.max(topic.round, 1)}
          total={topic.rounds}
          label={t("forum.roundProgress", { round: Math.max(topic.round, 1), rounds: topic.rounds })}
        />
      )}

      {topic.posts.length === 0 && open && <p className="muted">{t("forum.noPosts")}</p>}
      {postsByRound(topic).map(([round, posts]) => (
        <section key={round} className="forum-round" aria-labelledby={`round-${round}`}>
          <h2 id={`round-${round}`} className="forum-round__title">
            {round === 0 ? t("forum.round0") : t("forum.round", { n: round })}
          </h2>
          {posts.map((p) => (
            <article
              key={p.id}
              className={p.author.type === "person" ? "forum-post forum-post--person" : "forum-post"}
              aria-label={author(p)}
            >
              {p.author.type === "agent" ? (
                <AgentAvatar agentId={p.author.id} name={author(p)} />
              ) : (
                <Avatar name={author(p)} imageUrl={dir.memberById.get(p.author.id)?.image} />
              )}
              <div className="forum-post__body">
                <div className="forum-post__head">
                  <span className="forum-post__name">{author(p)}</span>
                  <time
                    className="small muted"
                    dateTime={p.createdAt}
                    title={relativeTime(t, i18n.language, p.createdAt)}
                  >
                    {formatTime(i18n.language, p.createdAt)}
                  </time>
                </div>
                <div className="forum-post__text">
                  <Markdown source={p.body} variant="message" wikiLink={wikiLink} />
                </div>
                {p.author.type === "agent" && p.agentRunId && (
                  <MessageWork runId={p.agentRunId} meta={p.meta} agentName={author(p)} />
                )}
              </div>
            </article>
          ))}
        </section>
      ))}

      {live.length > 0 && (
        <div className="forum-live" role="status">
          {live.map((a) => (
            <span key={a.id} className="forum-live__item">
              <AgentAvatar agentId={a.id} name={a.name} size="sm" state={a.state ?? undefined} />
              {t(a.state === "writing" ? "forum.writing" : "forum.thinking", { name: a.name })}
            </span>
          ))}
        </div>
      )}

      {topic.synthesis && (
        <section className="forum-synthesis" aria-labelledby="forum-synthesis">
          <h2 id="forum-synthesis" className="forum-round__title">
            {t("forum.synthesis")}
          </h2>
          {closing && (
            <div className="forum-post forum-post--synthesis">
              <AgentAvatar agentId={closing.author.id} name={author(closing)} />
              <div className="forum-post__body">
                <div className="forum-post__head">
                  <span className="forum-post__name">{author(closing)}</span>
                </div>
                <div className="forum-post__text">
                  <Markdown source={closing.body} variant="message" wikiLink={wikiLink} />
                </div>
              </div>
            </div>
          )}
          <div className="artifact-cards">
            <ArtifactCard artifact={{ id: topic.synthesis.artifactId, version: topic.synthesis.version }} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            {suggested.length > 0 && (
              <Button icon="issues" onClick={() => setIssues(true)}>
                {t("forum.suggestIssues", { count: suggested.length })}
              </Button>
            )}
            {closing && (
              <Button icon="book" onClick={() => setSavingWiki(true)}>
                {t("wiki.save")}
              </Button>
            )}
          </div>
          {closing && (
            <SaveToWikiDialog
              open={savingWiki}
              onClose={() => setSavingWiki(false)}
              text={closing.body}
              source={{ kind: "forum", topicId: topic.id }}
              from={t("wiki.fromForum")}
            />
          )}
        </section>
      )}

      {open && (
        <div className="forum-composer">
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={(text) => {
              setDraft("");
              action.mutate({ type: "post", topicId: topic.id, body: text });
            }}
            label={t("forum.composer")}
            placeholder={t("forum.composerPlaceholder")}
            sendLabel={t("channel.send")}
            sendText={t("channel.send")}
          />
          <p className="ac-composer__hint">{t("forum.composerHint")}</p>
        </div>
      )}

      <Dialog
        open={canceling}
        onOpenChange={setCanceling}
        title={t("forum.cancelTitle")}
        description={t("forum.cancelText")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setCanceling(false)}>{t("forum.keep")}</Button>
          <Button
            variant="danger"
            loading={action.isPending && action.variables?.type === "cancel"}
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                { type: "cancel", topicId: topic.id },
                {
                  onSuccess: () => {
                    setCanceling(false);
                    toast.show(t("forum.canceled"));
                  },
                },
              )
            }
          >
            {t("forum.cancel")}
          </Button>
        </DialogFooter>
      </Dialog>
      <CreateIssuesDialog topicId={topic.id} items={suggested} open={issues} onClose={() => setIssues(false)} />
      <ParticipantsDialog topic={topic} open={editingPeople} onClose={() => setEditingPeople(false)} />
    </div>
  );
}
