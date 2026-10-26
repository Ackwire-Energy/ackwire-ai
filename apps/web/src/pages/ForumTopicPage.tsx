import type { ForumPost, ForumSeat, ForumTopicDetail } from "@agenteschat/client";
import { runsInChannel, useForumAction, useForumTopic } from "@agenteschat/client";
import { formatTime, joinNames, relativeTime } from "@agenteschat/client/lib/format";
import {
  convergence,
  isEnded,
  isFor,
  isReopened,
  MAX_ROUNDS,
  nextSeat,
  outOfBudget,
  ownerOf,
  postRounds,
  postsByRound,
  seatsOf,
  standings,
  stripStanceHeader,
  trackGroups,
  turnNow,
} from "@agenteschat/client/lib/forum";
import {
  Avatar,
  Button,
  Chip,
  Composer,
  Convergence,
  cx,
  DetailsDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  type ForumTrackItem,
  Icon,
  layoutTrack,
  Menu,
  MenuItem,
  MenuSeparator,
  roundLabelBoxes,
  StanceLane,
  Switch,
  Textarea,
  WorkSweep,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  agentMode,
  deadlineLabel,
  ForumStatusChip,
  OriginLink,
  ParticipantsDialog,
  SeatAvatar,
  StanceChip,
  SynthesisCard,
  TopicTrack,
  useForumWho,
  useOrigin,
  useStanceText,
} from "@/components/Forum";
import { ErrorState, LoadingPage } from "@/components/Loading";
import { MessageWork } from "@/components/MessageWork";
import { useOrg } from "@/components/org-context";
import { SaveToWikiDialog } from "@/components/SaveToWiki";
import { isStoppable, StopButton, useStopRun } from "@/components/StopRun";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { useChannelRealtime, useStreams } from "@/realtime/context";
import "./forum.css";

export { postsByRound } from "@agenteschat/client/lib/forum";

/** Scrolls to an element of the topic and flashes it (a post the track or a reply points at). */
function go(id: string, flash = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: flash ? "center" : "start" });
  if (flash) {
    el.classList.remove("is-flash");
    void el.offsetWidth;
    el.classList.add("is-flash");
  }
}

/** A forum topic: header, the table, the rounds, the live turn, the synthesis and the side panel. */
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
          <EmptyState icon="message">{t("forum.topic.notFound")}</EmptyState>
        ) : (
          <ErrorState error={topic.error} onRetry={() => void topic.refetch()} />
        )}
      </div>
    );
  }
  return <TopicView topic={topic.data} />;
}

type Reround = { quote: string; replyTo?: string; draft?: boolean } | null;

function TopicView({ topic }: { topic: ForumTopicDetail }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const [sheet, setSheet] = useState(false);
  const [concluding, setConcluding] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [editingPeople, setEditingPeople] = useState(false);
  const [savingWiki, setSavingWiki] = useState(false);
  const [reround, setReround] = useState<Reround>(null);
  const [draft, setDraft] = useState("");
  const ended = isEnded(topic);
  // Live runs in the topic's channel (avatars think and write; the turn streams).
  useChannelRealtime(org.id, topic.channelId, !ended);
  const runs = useStreams((s) => runsInChannel(s, topic.channelId));
  const live = runs.filter(isStoppable);
  const active = [...new Set([...topic.activeAgentIds, ...live.map((r) => r.agentId)])];
  const now = turnNow(topic, active);
  const next = nextSeat(topic, active);
  const owner = ownerOf(topic);
  const { rounds, comments } = postsByRound(topic);
  const roundOf = postRounds(topic);
  // "Falar agora" / "Revisar issues" from the list land here with a hash.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const timer = setTimeout(() => {
      go(id);
      document.querySelector<HTMLTextAreaElement>(`#${id} textarea`)?.focus();
    }, 80);
    return () => clearTimeout(timer);
  }, []);
  const synthesisMarkdown = topic.syntheses.at(-1)?.markdown ?? "";
  const pick = (it: ForumTrackItem) => {
    if (it.postId) return go(`forum-post-${it.postId}`, true);
    if (it.kind === "synthesis") return go("forum-synthesis");
    if (it.kind === "live" || it.kind === "sleep" || it.kind === "waiting") return go("forum-live");
    go(`forum-r-${it.round}`);
  };
  const groups = trackGroups(topic, who.look, active);
  const layout = layoutTrack(groups, "big");
  const roundText = ended
    ? t("forum.rounds", { count: Math.max(1, topic.round) })
    : t("forum.roundOf", { round: Math.max(1, topic.round), rounds: topic.rounds });
  const requester = who.personName(topic.requestedByUserId);
  const responsible = who.personName(topic.responsibleUserId);
  const synthesizing = now?.kind === "synthesis";

  return (
    <div className="page forum-topic">
      <div className="forum-topic__main">
        <Link to="/org/$orgId/forum" params={{ orgId: org.id }} className="ac-back">
          <Icon name="chevronLeft" />
          {t("forum.topic.back")}
        </Link>
        <header className="forum-th">
          <div className="forum-th__t">
            <h1>{topic.title}</h1>
            <p className="forum-th__goal">
              <b>{t("forum.topic.goal")}</b>
              {topic.goal}
            </p>
            <div className="forum-meta">
              <ForumStatusChip topic={topic} />
              <OriginLink topic={topic} className="forum-meta__lnk" />
              <Chip icon="message">{roundText}</Chip>
              {responsible && (
                <span>
                  {t("forum.topic.responsible")}: <b>{responsible}</b>
                </span>
              )}
              {requester && topic.requestedByUserId !== topic.responsibleUserId && (
                <span>
                  {t("forum.topic.requestedBy")}: <b>{requester}</b>
                </span>
              )}
              {isReopened(topic) && topic.reopened && (
                <span>
                  {t("forum.topic.reopenedFor", { name: who.personName(topic.reopened.byUserId), round: topic.round })}
                </span>
              )}
              {topic.deadline && (
                <Chip icon="calendar">
                  {t("forum.until", { when: deadlineLabel(t, i18n.language, topic.deadline) })}
                </Chip>
              )}
            </div>
          </div>
          <div className="forum-th__acts">
            <Button size="sm" icon="sidebar" className="forum-only-narrow" onClick={() => setSheet(true)}>
              {t("forum.side.title")}
            </Button>
            {!ended && (
              <Button
                size="sm"
                variant="primary"
                icon="flag"
                disabled={synthesizing || topic.phase === "synthesizing"}
                onClick={() => setConcluding(true)}
              >
                {synthesizing ? t("forum.topic.concluding") : t("forum.topic.conclude")}
              </Button>
            )}
            <Menu
              align="end"
              label={t("forum.topic.more")}
              trigger={<Button variant="ghost" iconOnly icon="more" aria-label={t("forum.topic.more")} />}
            >
              <MenuItem
                icon="link"
                onSelect={async () => {
                  await navigator.clipboard?.writeText(window.location.href);
                  toast.show(t("forum.topic.linkCopied"));
                }}
              >
                {t("forum.topic.copyLink")}
              </MenuItem>
              <MenuItem icon="members" onSelect={() => setEditingPeople(true)}>
                {t("forum.topic.editParticipants")}
              </MenuItem>
              {topic.status === "done" && synthesisMarkdown && (
                <MenuItem icon="book" onSelect={() => setSavingWiki(true)}>
                  {t("forum.synthesis.saveWiki")}
                </MenuItem>
              )}
              {!ended && <MenuSeparator />}
              {!ended && (
                <MenuItem icon="block" danger onSelect={() => setCanceling(true)}>
                  {t("forum.topic.cancel")}
                </MenuItem>
              )}
            </Menu>
          </div>
        </header>

        <Table
          topic={topic}
          active={active}
          next={next}
          onPick={pick}
          layoutBoxes={roundLabelBoxes(layout)}
          trackMax={layout.width * layout.cell}
        />

        <div className="forum-posts">
          {topic.posts.length === 0 && !ended && now?.kind !== "agent" && (
            <p className="forum-quiet">{t("forum.posts.none", { name: who.agentName(owner) })}</p>
          )}
          {rounds.map(({ round, posts }) => {
            const tr = topic.track.rounds.find((r) => r.round === round);
            const starter = posts.find((p) => p.kind === "free");
            const said = posts.filter((p) => p.author.type === "agent" && p.kind === "turn").length;
            const beyond = round > topic.rounds && said === 0;
            const budget = tr?.entries.filter((e) => e.seat.type === "agent" && e.status === "skipped_budget") ?? [];
            const passed = tr?.entries.filter((e) => e.seat.type === "person" && e.status === "passed") ?? [];
            const done = round < topic.round || ended;
            const silent = done
              ? (tr?.entries
                  .filter((e) => e.seat.type === "agent" && e.status === "skipped")
                  .map((e) => who.agentName(e.seat.id)) ?? [])
              : [];
            const liveHere =
              !ended &&
              !!now &&
              now.kind !== "synthesis" &&
              !(now.kind === "stalled" && now.synthesis) &&
              now.round === round;
            return (
              <section
                key={round}
                className="forum-round"
                aria-labelledby={beyond ? undefined : `forum-rt-${round}`}
                aria-label={beyond ? t("forum.posts.round", { n: round }) : undefined}
              >
                {!beyond && (
                  <div className="forum-rdiv" id={`forum-r-${round}`}>
                    <span id={`forum-rt-${round}`}>{t("forum.posts.round", { n: round })}</span>
                    <i />
                    <small>
                      {starter ? `${t("forum.posts.startedWith", { name: who.personName(starter.author.id) })} · ` : ""}
                      {t("forum.posts.spokeCount", { said, total: topic.agentIds.length })}
                    </small>
                  </div>
                )}
                {posts.map((p) => (
                  <Post
                    key={p.id}
                    post={p}
                    topic={topic}
                    leads={p.kind === "free" ? roundOf(p) : null}
                    onReround={(quote, replyTo) => setReround({ quote, replyTo })}
                  />
                ))}
                {passed.map((e) => (
                  <p key={`p-${e.seat.id}`} className="forum-bskip ac-iconline">
                    <SeatAvatar seat={e.seat} size="xs" />
                    <span>{t("forum.posts.passedTurn", { name: who.seatName(e.seat) })}</span>
                  </p>
                ))}
                {budget.map((e) => (
                  <p key={`b-${e.seat.id}`} className="forum-bskip ac-iconline">
                    <SeatAvatar seat={e.seat} size="xs" mode="sleep" />
                    <span>{t("forum.posts.budgetSkip", { name: who.seatName(e.seat) })}</span>
                  </p>
                ))}
                {silent.length > 0 && said > 0 && (
                  <p className="forum-quiet ac-iconline">
                    <Icon name="dash" size={14} />
                    {t("forum.posts.didntSpeak", { count: silent.length, names: joinNames(silent, t("newAgent.and")) })}
                  </p>
                )}
                {liveHere && <LiveTurn topic={topic} active={active} />}
              </section>
            );
          })}
          {!ended &&
            (now?.kind === "synthesis" ||
              (now?.kind === "stalled" && (now.synthesis || !rounds.some((r) => r.round === now.round)))) && (
              <LiveTurn topic={topic} active={active} />
            )}
          {topic.status === "done" && <SynthesisCard topic={topic} />}
          {comments.length > 0 && (
            <section className="forum-round" aria-label={t("forum.posts.comments")}>
              <div className="forum-rdiv">
                <span>{t("forum.posts.comments")}</span>
                <i />
                <small>{t("forum.posts.afterSynthesis")}</small>
              </div>
              {comments.map((p) => (
                <Post
                  key={p.id}
                  post={p}
                  topic={topic}
                  leads={null}
                  onReround={(quote, replyTo) => setReround({ quote, replyTo })}
                />
              ))}
            </section>
          )}
        </div>

        <TopicComposer
          topic={topic}
          draft={draft}
          setDraft={setDraft}
          now={now}
          onReround={(quote) => setReround({ quote, draft: true })}
        />
      </div>

      <aside className="forum-topic__side" aria-label={t(ended ? "forum.side.titleDone" : "forum.side.title")}>
        <Standing topic={topic} active={active} next={next} />
      </aside>
      <DetailsDialog
        open={sheet}
        onOpenChange={setSheet}
        title={t(ended ? "forum.side.titleDone" : "forum.side.title")}
        closeLabel={t("common.close")}
        className="forum-sheet"
      >
        <Standing topic={topic} active={active} next={next} bare />
      </DetailsDialog>

      <ConcludeDialog topic={topic} open={concluding} onClose={() => setConcluding(false)} active={active} />
      <Dialog
        open={canceling}
        onOpenChange={setCanceling}
        title={t("forum.cancel.title")}
        description={t("forum.cancel.text")}
        closeLabel={t("common.close")}
        width={460}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCanceling(false)}>
            {t("forum.cancel.keep")}
          </Button>
          <Button
            variant="danger"
            icon="block"
            loading={action.isPending && action.variables?.type === "cancel"}
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                { type: "cancel", topicId: topic.id },
                {
                  onSuccess: () => {
                    setCanceling(false);
                    toast.show(t("forum.cancel.done"));
                  },
                },
              )
            }
          >
            {t("forum.cancel.ok")}
          </Button>
        </DialogFooter>
      </Dialog>
      <NewRoundDialog
        topic={topic}
        request={reround}
        onClose={() => setReround(null)}
        onDone={() => {
          setReround(null);
          setDraft("");
        }}
        draftBody={reround?.draft ? draft : undefined}
      />
      <ParticipantsDialog topic={topic} open={editingPeople} onClose={() => setEditingPeople(false)} />
      {synthesisMarkdown && (
        <SaveToWikiDialog
          open={savingWiki}
          onClose={() => setSavingWiki(false)}
          text={synthesisMarkdown}
          source={{ kind: "forum", topicId: topic.id }}
          from={t("wiki.fromForum")}
        />
      )}
    </div>
  );
}

// ── The table ────────────────────────────────────────────────────────────────

function Table({
  topic,
  active,
  next,
  onPick,
  layoutBoxes,
  trackMax,
}: {
  topic: ForumTopicDetail;
  active: string[];
  next: ForumSeat | null;
  onPick: (it: ForumTrackItem) => void;
  layoutBoxes: ReturnType<typeof roundLabelBoxes>;
  trackMax: number;
}) {
  const { t, i18n } = useTranslation();
  const who = useForumWho();
  const ended = isEnded(topic);
  const now = turnNow(topic, active);
  const owner = ownerOf(topic);
  const broke = outOfBudget(topic);
  const seats = seatsOf(topic);
  const lastPost = (seat: ForumSeat) =>
    topic.posts
      .filter((p) => p.author.type === seat.type && p.author.id === seat.id && (p.kind === "turn" || p.kind === "seat"))
      .at(-1);
  const passed = (userId: string) =>
    topic.track.rounds.some((r) =>
      r.entries.some((e) => e.seat.type === "person" && e.seat.id === userId && e.status === "passed"),
    );
  const seatState = (seat: ForumSeat): { text: ReactNode; cur: boolean } => {
    const last = lastPost(seat);
    const spokeAt = last ? t("forum.table.spokeAt", { time: formatTime(i18n.language, last.createdAt) }) : null;
    const isNext = next?.type === seat.type && next.id === seat.id;
    if (seat.type === "person") {
      if (now?.kind === "person" && now.userId === seat.id)
        return {
          cur: true,
          text: seat.id === who.me ? <Chip icon="flag">{t("forum.table.yourTurn")}</Chip> : t("forum.table.waits"),
        };
      if (isNext) return { cur: false, text: <Chip icon="arrowRight">{t("forum.table.next")}</Chip> };
      return { cur: false, text: spokeAt ?? (passed(seat.id) ? t("forum.table.passed") : t("forum.table.notYet")) };
    }
    const mode = agentMode(topic, seat.id, next);
    if (mode === "sleep")
      return {
        cur: false,
        text: (
          <>
            <Icon name="pause" size={14} />
            {t("forum.table.stopped")}
          </>
        ),
      };
    if (mode === "run" || mode === "think") {
      const syn = now?.kind === "synthesis";
      return {
        cur: true,
        text:
          mode === "think" ? (
            t(syn ? "forum.table.rereading" : "forum.table.reading")
          ) : (
            <>
              {t(syn ? "forum.table.writingSynthesis" : "forum.table.writing")}
              <span className="forum-cursor" aria-hidden="true" />
            </>
          ),
      };
    }
    if (!ended && broke.includes(seat.id))
      return {
        cur: false,
        text: (
          <>
            <Icon name="coin" size={14} />
            {t("forum.table.broke")}
          </>
        ),
      };
    if (mode === "next") return { cur: false, text: <Chip icon="arrowRight">{t("forum.table.next")}</Chip> };
    if (topic.status === "done" && topic.track.synthesis?.agentId === seat.id)
      return { cur: false, text: t("forum.table.wroteSynthesis") };
    return { cur: false, text: spokeAt ?? t("forum.table.notYet") };
  };
  const notified = topic.userIds.filter((id) => !seats.some((s) => s.type === "person" && s.id === id));
  return (
    <section className="forum-mesa" aria-labelledby="forum-mesa-h">
      <div className="forum-mesa__h">
        <h2 id="forum-mesa-h">{t("forum.table.title")}</h2>
        <span className="forum-mesa__sub">{t(ended ? "forum.table.orderDone" : "forum.table.order")}</span>
      </div>
      <div className="forum-seats">
        {seats.map((seat, i) => {
          const st = seatState(seat);
          const name = who.seatName(seat);
          const role = seat.type === "agent" ? who.dir.agentById.get(seat.id)?.role : null;
          return (
            <div key={`${seat.type}:${seat.id}`} className={cx("forum-seat", st.cur && !ended && "is-cur")}>
              <span className="forum-seat__no">{i + 1}</span>
              <span className="forum-seat__av">
                <SeatAvatar
                  seat={seat}
                  size="md"
                  mode={seat.type === "agent" ? agentMode(topic, seat.id, next) : "idle"}
                  channelId={topic.channelId}
                />
              </span>
              <span className="forum-seat__t">
                <b>{seat.type === "person" && seat.id === who.me ? t("forum.you", { name }) : name}</b>
                <small>
                  {seat.type === "person"
                    ? t("forum.table.seatedPerson")
                    : [
                        role,
                        seat.id === owner
                          ? t(topic.format === "plan" ? "forum.table.writesPlan" : "forum.table.writes")
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </small>
                <em>{st.text}</em>
              </span>
            </div>
          );
        })}
      </div>
      <div className="forum-ppl">
        {notified.map((id) => {
          const name = who.personName(id);
          const posts = topic.posts.filter((p) => p.author.type === "person" && p.author.id === id);
          return (
            <span key={id}>
              <SeatAvatar seat={{ type: "person", id }} size="xs" />
              <b>{id === who.me ? t("forum.you", { name }) : name}</b>
              {posts.length
                ? t("forum.table.entered", { round: posts.at(-1)?.round ?? 1 })
                : t("forum.table.readsCanEnter")}
            </span>
          );
        })}
        <span>
          <Icon name="members" size={14} />
          {t("forum.table.orgReads")}
        </span>
      </div>
      <div className="forum-trkwrap">
        <div style={{ maxWidth: trackMax }}>
          <TopicTrack topic={{ ...topic, activeAgentIds: active }} size="big" onPick={onPick} />
          <div className="forum-rlabs">
            {layoutBoxes.map((b) => (
              <button
                key={b.round}
                type="button"
                className={cx("forum-rl", b.round === topic.round && !ended && "is-cur")}
                style={{ left: `${b.left}%`, width: `${b.width}%` }}
                onClick={() => go(`forum-r-${b.round}`)}
                aria-label={t("forum.track.round", { n: b.round })}
              >
                {b.narrow ? t("forum.track.roundShort", { n: b.round }) : t("forum.track.round", { n: b.round })}
              </button>
            ))}
          </div>
        </div>
        <p className="forum-lanekey">
          {[
            t("forum.track.key"),
            ended ? (topic.status === "done" ? t("forum.track.keyDone") : "") : t("forum.track.keyLive"),
            t("forum.track.keyClick"),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      </div>
    </section>
  );
}

// ── Posts ────────────────────────────────────────────────────────────────────

function ReplyRef({ topic, replyTo }: { topic: ForumTopicDetail; replyTo: string | null }) {
  const { t } = useTranslation();
  const who = useForumWho();
  const ref = replyTo ? topic.posts.find((p) => p.id === replyTo) : undefined;
  if (!ref) return null;
  const name = ref.author.type === "agent" ? who.agentName(ref.author.id) : who.personName(ref.author.id);
  return (
    <button
      type="button"
      className="forum-qref"
      onClick={() => go(`forum-post-${ref.id}`, true)}
      aria-label={t("forum.posts.replyTo", { name })}
    >
      <Icon name="reply" size={14} />
      <SeatAvatar seat={{ type: ref.author.type, id: ref.author.id }} size="xs" />
      <b>{name}</b>
      <span>{ref.position || ref.body.replace(/\s+/g, " ").slice(0, 140)}</span>
    </button>
  );
}

function Post({
  post: p,
  topic,
  leads,
  onReround,
}: {
  post: ForumPost;
  topic: ForumTopicDetail;
  /** A person's free post: the round it leads. */
  leads: number | null;
  onReround: (quote: string, replyTo: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const who = useForumWho();
  const wikiLink = useWikiLinkRenderer();
  const agent = p.author.type === "agent";
  const name = agent ? who.agentName(p.author.id) : who.personName(p.author.id);
  const time = (
    <time className="forum-post__tm" dateTime={p.createdAt} title={relativeTime(t, i18n.language, p.createdAt)}>
      {formatTime(i18n.language, p.createdAt)}
    </time>
  );
  const stopped = topic.track.rounds.some((r) =>
    r.entries.some((e) => e.postId === p.id && (e.status === "stopped" || e.status === "failed")),
  );
  if (agent) {
    return (
      <article className="forum-post" id={`forum-post-${p.id}`} aria-label={name}>
        <SeatAvatar seat={{ type: "agent", id: p.author.id }} size="md" />
        <div className="forum-post__c">
          <div className="forum-post__h">
            <b>{name}</b>
            <span className="forum-post__role">{who.dir.agentById.get(p.author.id)?.role}</span>
            {time}
            <StanceChip stance={p.stance} />
          </div>
          <ReplyRef topic={topic} replyTo={p.replyTo} />
          <div className="forum-post__tx">
            <Markdown source={p.body} variant="message" wikiLink={wikiLink} />
          </div>
          {stopped && <p className="forum-post__stop">{t("forum.posts.stopped")}</p>}
          {p.agentRunId && <MessageWork runId={p.agentRunId} meta={p.meta} agentName={name} />}
        </div>
      </article>
    );
  }
  const canReround = topic.status === "done";
  return (
    <article className="forum-post forum-post--person" id={`forum-post-${p.id}`} aria-label={name}>
      <SeatAvatar seat={{ type: "person", id: p.author.id }} size="md" />
      <div className="forum-post__c">
        <div className="forum-post__h">
          <b>{name}</b>
          <span className="forum-post__role">{t("forum.posts.person")}</span>
          {time}
          {p.requestRound && <Chip icon="repeat">{t("forum.posts.askedRound")}</Chip>}
          {p.kind === "seat" && <Chip icon="flag">{t("forum.posts.inTurn")}</Chip>}
          {canReround && (
            <Button
              variant="ghost"
              size="sm"
              icon="repeat"
              className="forum-post__act"
              onClick={() => onReround(p.body, p.id)}
            >
              {t("forum.posts.reroundFrom")}
            </Button>
          )}
        </div>
        <ReplyRef topic={topic} replyTo={p.replyTo} />
        <div className="forum-post__tx forum-post__bubble">
          <Markdown source={p.body} variant="message" wikiLink={wikiLink} />
        </div>
        {leads !== null && (
          <p className="forum-note ac-iconline">
            <Icon name="flag" size={14} />
            {leads > topic.rounds
              ? t("forum.posts.last")
              : t(leads > topic.round ? "forum.posts.starts" : "forum.posts.started", { round: leads })}
          </p>
        )}
      </div>
    </article>
  );
}

// ── The live turn ────────────────────────────────────────────────────────────

/** The turn in progress (streaming, with Parar), a seated person's turn ("Sua vez"), or the stalled turn. */
function LiveTurn({ topic, active }: { topic: ForumTopicDetail; active: string[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const { canStop, stop } = useStopRun();
  const runs = useStreams((s) => runsInChannel(s, topic.channelId));
  const [text, setText] = useState("");
  const [concluding, setConcluding] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const now = turnNow(topic, active);
  if (!now) return null;

  if (now.kind === "stalled") {
    const name = who.agentName(now.agentId);
    const failed = topic.stall?.reason === "failed";
    const by = who.personName(topic.stall?.byUserId);
    return (
      <div className="forum-stalled" id="forum-live">
        {now.agentId && <SeatAvatar seat={{ type: "agent", id: now.agentId }} size="md" mode="sleep" />}
        <div className="forum-stalled__t">
          <b>
            <Icon name="pause" size={16} />
            {now.synthesis || !name
              ? t("forum.stalled.titleSynthesis")
              : t("forum.stalled.title", { name, of: who.g(name).of })}
          </b>
          <small>
            {failed
              ? t("forum.stalled.failed")
              : by
                ? t("forum.stalled.stopped", { name: by })
                : t("forum.stalled.stoppedAnon")}
          </small>
        </div>
        <div className="forum-stalled__acts">
          {!failed && (
            <Button size="sm" variant="ghost" onClick={() => setConcluding(true)}>
              {t("forum.stalled.concludeNow")}
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            icon="play"
            loading={action.isPending && action.variables?.type === "resume"}
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                { type: "resume", topicId: topic.id },
                { onSuccess: () => toast.show(t("forum.stalled.resumed")) },
              )
            }
          >
            {t(failed ? "forum.stalled.retry" : "forum.stalled.resume")}
          </Button>
        </div>
        <ConcludeDialog topic={topic} open={concluding} onClose={() => setConcluding(false)} active={active} />
      </div>
    );
  }

  if (now.kind === "person") {
    if (now.userId !== who.me)
      return (
        <p className="forum-bskip ac-iconline" id="forum-live">
          <SeatAvatar seat={{ type: "person", id: now.userId }} size="xs" />
          <span>{t("forum.liveTurn.waitsFor", { name: who.personName(now.userId) })}</span>
        </p>
      );
    const send = () => {
      const body = text.trim();
      if (!body) return box.current?.focus();
      action.mutate(
        { type: "post", topicId: topic.id, input: { body } },
        {
          onSuccess: () => {
            setText("");
            toast.show(t("forum.liveTurn.spoke"));
          },
        },
      );
    };
    return (
      <article className="forum-post forum-livep forum-seatp" id="forum-live">
        <SeatAvatar seat={{ type: "person", id: who.me }} size="md" />
        <div className="forum-post__c">
          <div className="forum-post__h">
            <b>{t("forum.liveTurn.yourTurn")}</b>
            <span className="forum-post__tm is-live">{t("forum.liveTurn.yourTurnSub", { round: now.round })}</span>
          </div>
          <div className="forum-seatbox">
            <Textarea
              ref={box}
              rows={2}
              value={text}
              aria-label={t("forum.liveTurn.yourTurn")}
              placeholder={t("forum.liveTurn.yourTurnPlaceholder")}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="forum-seatbox__tools">
              <span className="forum-grow" />
              <Button
                size="sm"
                variant="ghost"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate(
                    { type: "pass", topicId: topic.id },
                    { onSuccess: () => toast.show(t("forum.liveTurn.passed")) },
                  )
                }
              >
                {t("forum.liveTurn.pass")}
              </Button>
              <Button size="sm" variant="primary" icon="send" disabled={action.isPending} onClick={send}>
                {t("forum.liveTurn.send")}
              </Button>
            </div>
          </div>
          {topic.deadline && (
            <p className="forum-chint ac-iconline">
              <Icon name="calendar" size={14} />
              {t("forum.liveTurn.deadline", { when: deadlineLabel(t, i18n.language, topic.deadline) })}
            </p>
          )}
        </div>
      </article>
    );
  }

  const agentId = now.agentId ?? ownerOf(topic);
  if (!agentId) return null;
  const run = runs.find((r) => r.agentId === agentId && isStoppable(r));
  const shown = run ? stripStanceHeader(run.text) : "";
  const writing = shown.length > 0 || (now.kind === "agent" && now.writing);
  const synthesis = now.kind === "synthesis";
  const name = who.agentName(agentId);
  const tm = synthesis
    ? t(writing ? "forum.liveTurn.synthesis" : "forum.liveTurn.rereading")
    : t(writing ? "forum.liveTurn.writing" : "forum.liveTurn.reading", { round: now.round });
  return (
    <article className="forum-post forum-livep" id="forum-live" aria-live="polite" aria-label={name}>
      <SeatAvatar
        seat={{ type: "agent", id: agentId }}
        size="md"
        mode={writing ? "run" : "think"}
        channelId={topic.channelId}
      />
      <div className="forum-post__c">
        <div className="forum-post__h">
          <b>{name}</b>
          <span className="forum-post__role">{who.dir.agentById.get(agentId)?.role}</span>
          <span className="forum-post__tm is-live">{tm}</span>
          <span className="forum-grow" />
          {run && (canStop(run) || topic.responsibleUserId === who.me) && (
            <StopButton run={run} onStop={stop} place="forum" />
          )}
        </div>
        <div className={cx("forum-post__tx", !writing && "is-think")}>
          {writing && shown ? (
            <>
              {shown}
              <span className="forum-cursor" aria-hidden="true" />
            </>
          ) : (
            <>
              {t("forum.liveTurn.readingLine")}
              <span className="forum-cursor is-dim" aria-hidden="true" />
            </>
          )}
        </div>
      </div>
      {writing && <WorkSweep color={who.colorOf(agentId)} />}
    </article>
  );
}

// ── The composer ─────────────────────────────────────────────────────────────

function TopicComposer({
  topic,
  draft,
  setDraft,
  now,
  onReround,
}: {
  topic: ForumTopicDetail;
  draft: string;
  setDraft: (v: string) => void;
  now: ReturnType<typeof turnNow>;
  onReround: (quote: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const last = topic.round >= topic.rounds && topic.rounds < MAX_ROUNDS;
  const [more, setMore] = useState(true);
  const [ask, setAsk] = useState(false);
  const owner = ownerOf(topic);
  const ownerName = who.agentName(owner);
  if (topic.status === "canceled")
    return (
      <div className="forum-closed ac-iconline">
        <Icon name="block" size={16} />
        <span>{t("forum.closed.canceled")}</span>
      </div>
    );
  if (topic.status === "done") {
    const send = (text: string) => {
      const body = text.trim();
      if (!body) return;
      if (ask) return onReround(body);
      action.mutate(
        { type: "post", topicId: topic.id, input: { body } },
        {
          onSuccess: () => {
            setDraft("");
            toast.show(t("forum.composer.commented"));
          },
        },
      );
    };
    return (
      <div className="forum-cmpw" id="forum-composer">
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          label={t("forum.composer.commentLabel")}
          placeholder={t("forum.composer.commentPlaceholder")}
          sendLabel={ask ? t("forum.composer.commentAndRound") : t("forum.composer.comment")}
          sendText={ask ? t("forum.composer.commentAndRound") : t("forum.composer.comment")}
          disabled={action.isPending}
          pills={
            <label className="forum-toggle" htmlFor="forum-reround">
              <Switch id="forum-reround" checked={ask} onCheckedChange={setAsk} />
              <span>{t("forum.composer.reround")}</span>
            </label>
          }
        />
        <p className="forum-chint ac-iconline">
          <Icon name="repeat" size={14} />
          {ask
            ? t("forum.composer.reroundHint", { name: ownerName, the: who.g(ownerName).article })
            : t("forum.composer.doneHint")}
        </p>
      </div>
    );
  }
  if (topic.status === "stalled") return null;
  if (now?.kind === "person" && now.userId === who.me) return null;
  if (now?.kind === "synthesis")
    return (
      <div className={owner ? "forum-closed ac-iconline" : "forum-closed"}>
        {owner && <SeatAvatar seat={{ type: "agent", id: owner }} size="xs" mode="run" />}
        <span>{t("forum.closed.synthesizing", { name: ownerName, The: who.g(ownerName).The })}</span>
      </div>
    );
  const send = (text: string) => {
    const body = text.trim();
    if (!body) return;
    const extra = last && more;
    action.mutate(
      { type: "post", topicId: topic.id, input: { body, ...(extra ? { requestRound: {} } : {}) } },
      {
        onSuccess: () => {
          setDraft("");
          toast.show(t(last && !more ? "forum.composer.sentLast" : "forum.composer.sent"));
        },
      },
    );
  };
  return (
    <div className="forum-cmpw" id="forum-composer">
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={send}
        label={t("forum.composer.label")}
        placeholder={t("forum.composer.placeholder")}
        sendLabel={t("forum.composer.send")}
        sendText={t("forum.composer.send")}
        disabled={action.isPending}
        pills={
          last ? (
            <label className="forum-toggle" htmlFor="forum-more">
              <Switch id="forum-more" checked={more} onCheckedChange={setMore} />
              <span>{t("forum.composer.moreRound")}</span>
            </label>
          ) : undefined
        }
      />
      <p className="forum-chint ac-iconline">
        <Icon name="flag" size={14} />
        {t(last && !more ? "forum.composer.hintLast" : "forum.composer.hint")}
      </p>
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

/** "Concluir o tópico?": who finishes their turn, who writes the synthesis, where it goes. */
function ConcludeDialog({
  topic,
  open,
  onClose,
  active,
}: {
  topic: ForumTopicDetail;
  open: boolean;
  onClose: () => void;
  active: string[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const now = turnNow(topic, active);
  const cur = now?.kind === "agent" ? now.agentId : null;
  const curName = who.agentName(cur);
  const owner = ownerOf(topic);
  const ownerName = who.agentName(owner);
  const plan = topic.format === "plan";
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("forum.conclude.title")}
      description={t("forum.conclude.text")}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        <ol className="forum-steps3">
          <li>
            <span className="forum-steps3__k">1</span>
            <span>
              {cur
                ? t("forum.conclude.finishes", { name: curName, The: who.g(curName).The, hers: who.g(curName).hers })
                : t("forum.conclude.nobody")}
              <small>{cur ? t("forum.conclude.finishesSub") : t("forum.conclude.nobodySub")}</small>
            </span>
          </li>
          <li>
            {owner ? (
              <SeatAvatar seat={{ type: "agent", id: owner }} size="sm" />
            ) : (
              <span className="forum-steps3__k">2</span>
            )}
            <span>
              {t("forum.conclude.writes", { name: ownerName, The: who.g(ownerName).The })}
              <small>{t(plan ? "forum.conclude.writesSubPlan" : "forum.conclude.writesSub")}</small>
            </span>
          </li>
          <li>
            <span className="forum-steps3__k">
              <Icon name="document" size={14} />
            </span>
            <span>
              {t("forum.conclude.goes")}
              <small>{t("forum.conclude.goesSub")}</small>
            </span>
          </li>
        </ol>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("forum.conclude.keep")}
        </Button>
        <Button
          variant="primary"
          icon="flag"
          loading={action.isPending && action.variables?.type === "conclude"}
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "conclude", topicId: topic.id },
              {
                onSuccess: () => {
                  onClose();
                  toast.show(t("forum.conclude.done"));
                },
              },
            )
          }
        >
          {t("forum.conclude.ok")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "Pedir nova rodada": the comment it starts from, and who answers (in the table's order). */
function NewRoundDialog({
  topic,
  request,
  onClose,
  onDone,
  draftBody,
}: {
  topic: ForumTopicDetail;
  request: Reround;
  onClose: () => void;
  onDone: () => void;
  /** The composer's text (the post that asks for the round); otherwise a new short post. */
  draftBody?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const [picked, setPicked] = useState<string[]>(topic.agentIds);
  const [note, setNote] = useState("");
  const broke = outOfBudget(topic);
  const open = request !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: everyone answers by default each time it opens
  useEffect(() => {
    if (open) {
      setPicked(topic.agentIds);
      setNote("");
    }
  }, [open]);
  const fromComment = request && !request.draft;
  const ok = () => {
    if (!request || picked.length === 0) return;
    const body = (draftBody ?? note).trim() || t("forum.newRound.defaultBody");
    const agentIds = topic.agentIds.filter((a) => picked.includes(a));
    action.mutate(
      {
        type: "post",
        topicId: topic.id,
        input: {
          body,
          requestRound: agentIds.length === topic.agentIds.length ? {} : { agentIds },
          ...(fromComment && request.replyTo ? { replyTo: request.replyTo } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.show(t("forum.newRound.done", { round: topic.round + 1 }));
          onDone();
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("forum.newRound.title")}
      description={t(fromComment ? "forum.newRound.textFrom" : "forum.newRound.text", { round: topic.round + 1 })}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        {request && <div className="forum-qbox">{request.quote}</div>}
        {fromComment && (
          <Textarea
            rows={2}
            value={note}
            aria-label={t("forum.newRound.note")}
            placeholder={t("forum.newRound.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
        <span className="ac-field__label">
          {t("forum.newRound.who")} <span className="forum-fld__hint">{t("forum.newRound.whoHint")}</span>
        </span>
        <div className="forum-rpick">
          {topic.agentIds.map((id, i) => {
            const name = who.agentName(id);
            const on = picked.includes(id);
            return (
              <label key={id} htmlFor={`fr-${id}`}>
                <input
                  id={`fr-${id}`}
                  type="checkbox"
                  className="forum-sr"
                  checked={on}
                  onChange={() => setPicked((l) => (on ? l.filter((x) => x !== id) : [...l, id]))}
                />
                <span className={cx("forum-ck", on && "is-on")} aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
                <AgentAvatar agentId={id} name={name} size="sm" state="idle" />
                <b>{name}</b>
                <small>
                  {broke.includes(id) ? t("forum.newRound.broke") : t("forum.newRound.speaksAt", { n: i + 1 })}
                </small>
              </label>
            );
          })}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          icon="repeat"
          disabled={picked.length === 0 || action.isPending}
          loading={action.isPending}
          onClick={ok}
        >
          {t("forum.newRound.ok")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── Where each one stands ────────────────────────────────────────────────────

function Standing({
  topic,
  active,
  next,
  bare = false,
}: {
  topic: ForumTopicDetail;
  active: string[];
  next: ForumSeat | null;
  bare?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const who = useForumWho();
  const stance = useStanceText();
  const origin = useOrigin()(topic);
  const [people, setPeople] = useState(false);
  const ended = isEnded(topic);
  const list = standings(topic, active);
  const conv = convergence(topic);
  const broke = outOfBudget(topic);
  const now = turnNow(topic, active);
  const creator =
    topic.createdBy.type === "agent" ? who.agentName(topic.createdBy.id) : who.personName(topic.createdBy.id);
  const askers = conv.askers.map((id) => who.agentName(id));
  return (
    <div className={cx("forum-pin", bare && "forum-pin--bare")}>
      {!bare && (
        <div className="forum-pin__h">
          <h2>{t(ended ? "forum.side.titleDone" : "forum.side.title")}</h2>
        </div>
      )}
      <div className="forum-cv">
        <Convergence
          blocks={list.map((s) => ({
            color: who.colorOf(s.agentId),
            level: isFor(s.last?.stance?.kind) ? "for" : s.last?.stance?.kind === "ask" ? "ask" : "none",
          }))}
          label={t("forum.side.agree", { count: conv.agree.length, total: conv.total })}
        />
        <div>
          <b>{t("forum.side.agree", { count: conv.agree.length, total: conv.total })}</b>
          <small>
            {t(ended ? "forum.side.withDecision" : "forum.side.withProposal")}
            {askers.length > 0 &&
              ` · ${t("forum.side.askers", { count: askers.length, names: joinNames(askers, t("newAgent.and")) })}`}
          </small>
        </div>
      </div>
      <div className="forum-ps">
        <h3>{t("forum.side.agents")}</h3>
        {list.map((s) => {
          const name = who.agentName(s.agentId);
          const writing = now?.kind === "agent" && now.writing && now.agentId === s.agentId;
          const lanes = s.lane
            .map((c, i) => {
              const post = topic.posts
                .filter(
                  (p) =>
                    p.author.type === "agent" && p.author.id === s.agentId && p.kind === "turn" && p.round === i + 1,
                )
                .at(-1);
              return post
                ? t("forum.side.laneRound", { round: i + 1, stance: stance(post.stance) || t("forum.side.spoke") })
                : c === "live"
                  ? t("forum.side.laneLive", { round: i + 1 })
                  : null;
            })
            .filter(Boolean)
            .join("; ");
          return (
            <div key={s.agentId} className="forum-ag">
              <SeatAvatar seat={{ type: "agent", id: s.agentId }} size="sm" mode={agentMode(topic, s.agentId, next)} />
              <div className="forum-ag__t">
                <b>{name}</b>
                <span className="forum-ag__role">{who.dir.agentById.get(s.agentId)?.role}</span>
              </div>
              <div className="forum-ag__pos">
                {s.last?.position ??
                  (writing
                    ? t("forum.side.firstWriting")
                    : s.last
                      ? s.last.body.replace(/\s+/g, " ").slice(0, 120)
                      : t("forum.side.notYet"))}
              </div>
              <div className="forum-ag__lane">
                <StanceLane
                  lane={s.lane}
                  color={who.colorOf(s.agentId)}
                  label={lanes ? t("forum.side.laneLabel", { name, list: lanes }) : t("forum.side.laneEmpty", { name })}
                />
                <span>
                  {writing
                    ? t("forum.side.writingNow")
                    : !ended && broke.includes(s.agentId)
                      ? t("forum.side.broke")
                      : s.last?.stance
                        ? stance(s.last.stance).toLocaleLowerCase(i18n.language)
                        : ""}
                </span>
              </div>
            </div>
          );
        })}
        <p className="forum-lanekey">{t("forum.side.laneKey")}</p>
      </div>
      <div className="forum-ps">
        <h3>{t("forum.side.details")}</h3>
        <dl className="forum-facts">
          <dt>{t("forum.side.rounds")}</dt>
          <dd>
            {ended
              ? t("forum.side.roundsDone", { round: Math.max(1, topic.round), rounds: topic.rounds })
              : t("forum.roundOf", { round: Math.max(1, topic.round), rounds: topic.rounds })}
          </dd>
          <dt>{t("forum.side.format")}</dt>
          <dd>{t(`forum.format.${topic.format}`)}</dd>
          <dt>{t("forum.side.deadline")}</dt>
          <dd>{topic.deadline ? deadlineLabel(t, i18n.language, topic.deadline) : t("forum.noDeadline")}</dd>
          <dt>{t("forum.side.origin")}</dt>
          <dd>
            <OriginLink topic={topic} className="forum-facts__lnk">
              {origin.text}
            </OriginLink>
          </dd>
          {creator && (
            <>
              <dt>{t("forum.side.openedBy")}</dt>
              <dd>
                <SeatAvatar seat={{ type: topic.createdBy.type, id: topic.createdBy.id }} size="xs" />
                {creator}
              </dd>
            </>
          )}
          {topic.responsibleUserId && (
            <>
              <dt>{t("forum.topic.responsible")}</dt>
              <dd>
                <Avatar
                  kind="person"
                  size="xs"
                  name={who.personName(topic.responsibleUserId)}
                  imageUrl={who.dir.memberById.get(topic.responsibleUserId)?.image}
                />
                {who.personName(topic.responsibleUserId)}
              </dd>
            </>
          )}
        </dl>
        <Button size="sm" icon="members" onClick={() => setPeople(true)} className="forum-ps__btn">
          {t("forum.side.participants")}
          <span className="forum-seg-n ac-num">{topic.agentIds.length + topic.userIds.length}</span>
        </Button>
        <ParticipantsDialog topic={topic} open={people} onClose={() => setPeople(false)} />
      </div>
    </div>
  );
}
