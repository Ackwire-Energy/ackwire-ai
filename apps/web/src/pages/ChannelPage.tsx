import {
  Avatar,
  AvatarStack,
  Button,
  Composer,
  DayDivider,
  Dialog,
  DialogSearchList,
  EmptyState,
  Field,
  Icon,
  Input,
  Message,
  MessageText,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ApiError } from "@/api/http";
import {
  sendHelpers,
  useApproval,
  useApprovals,
  useChannelMembers,
  useChannels,
  useJoinChannel,
  useMessages,
  usePostMessage,
  useRoster,
  useThreads,
  useUpdateChannel,
} from "@/api/queries";
import type { Agent, Approval, Channel, Member, Message as MessageType } from "@/api/types";
import { tokenizeBody } from "@/chat/body";
import { MessageBody } from "@/chat/MessageBody";
import { buildTimeline, mergeTimeline, threadRootsToLoad } from "@/chat/timeline";
import { InlineApproval } from "@/components/ApprovalItem";
import { InlineProposal, MemoryChangeCard } from "@/components/ChatCards";
import { type ChannelActions, ChannelActionsContext, useChannelActions } from "@/components/channel-actions";
import { MessageFeedback } from "@/components/MessageFeedback";
import { MessageReceipts } from "@/components/MessageReceipts";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { dayLabel, formatTime, joinNames } from "@/lib/format";
import { can } from "@/lib/permissions";
import {
  useChannelRealtime,
  useConnectionStatus,
  useDismissRun,
  useLive,
  useLiveStore,
  useStreams,
  useTypingSender,
} from "@/realtime/context";
import { type LiveRun, runsInChannel } from "@/realtime/streams";
import { typingIn } from "@/realtime/typing";

/** Header and empty state of a channel, or of a DM (same layout). */
export interface ChannelChrome {
  header?: ReactNode;
  emptyText?: string;
  /** Composer label/placeholder target, e.g. "Ada" instead of "#eng". */
  composerTarget?: string;
}

const sameRuns = (a: LiveRun[], b: LiveRun[]) => a.length === b.length && a.every((r, i) => r === b[i]);

/** telas/Main.dc.html — a channel with real-time messages, streaming agent replies and inline approvals. */
export function ChannelPage({
  channelId,
  chrome,
  fallback,
}: {
  channelId: string;
  chrome?: ChannelChrome;
  /** DMs may not be in the channel list: the page still works with this. */
  fallback?: Channel;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const channel = channels.data?.find((c) => c.id === channelId) ?? fallback;

  if (channels.isPending && !fallback) return <main className="shell__main shell__main--chat" aria-busy="true" />;
  if (!channel) {
    return (
      <main className="shell__main">
        <div className="page page--mid">
          <EmptyState icon="channel">{t("channel.notFound")}</EmptyState>
        </div>
      </main>
    );
  }
  return <ChannelView key={channel.id} channel={channel} chrome={chrome} />;
}

function ChannelView({ channel, chrome }: { channel: Channel; chrome?: ChannelChrome }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const isMember = channel.isMember;
  const members = useChannelMembers(org.id, channel.id, isMember);
  const messages = useMessages(org.id, channel.id, isMember);
  const roots = useMemo(() => threadRootsToLoad(messages.data ?? []), [messages.data]);
  const threads = useThreads(org.id, channel.id, isMember ? roots : []);
  const live = useLiveStore();
  const status = useConnectionStatus();
  const join = useJoinChannel(org.id, channel.id);
  const sendTyping = useTypingSender(channel.id);
  const [draft, setDraft] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  useChannelRealtime(org.id, channel.id, isMember);

  const channelAgents = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.type === "agent")
        .map((m) => dir.agentById.get(m.id))
        .filter((a): a is Agent => Boolean(a)),
    [members.data, dir.agentById],
  );
  const channelPeople = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.type === "person")
        .map((m) => dir.memberById.get(m.id))
        .filter((p): p is Member => Boolean(p)),
    [members.data, dir.memberById],
  );

  /** Agents of this channel the text mentions (instant "pensando…" before the server answers). */
  const mentioned = (body: string) =>
    tokenizeBody(body)
      .flatMap((tok) => (tok.type === "mention" ? [dir.agentByHandle.get(tok.handle.toLowerCase())] : []))
      .filter((a): a is Agent => Boolean(a && channelAgents.some((c) => c.id === a.id)))
      .map((a) => a.id);

  const post = usePostMessage(org.id, channel.id, {
    me: { id: me.user.id },
    mentioned,
    // In a DM with an agent, it is the one who answers.
    onOptimistic: (local) => {
      const agents = local.mentionedAgentIds.length
        ? local.mentionedAgentIds
        : channelAgents.length === 1 && channelPeople.length <= 1
          ? channelAgents.map((a) => a.id)
          : [];
      live.expect(channel.id, local.id, agents);
    },
    onSent: (message, local) => live.retarget(local.id, message.id),
  });
  const { send, retry } = sendHelpers(post);

  // Reading the channel marks it read (unread counts in the DM list).
  const api = useApi();
  const lastId = messages.data?.at(-1)?.id;
  useEffect(() => {
    if (isMember && lastId) api.dms.markRead(org.id, channel.id).catch(() => {});
  }, [api, org.id, channel.id, isMember, lastId]);

  // Person messages loaded over HTTP start their receipts.
  useEffect(() => {
    if (messages.data) live.seed(messages.data);
  }, [messages.data, live]);

  const timeline = useMemo(
    () =>
      buildTimeline(
        mergeTimeline(
          messages.data ?? [],
          threads.map((q) => q.data),
        ),
        [],
        [],
      ),
    [messages.data, threads],
  );

  // Keep the newest message in view while the person is at the bottom.
  const scroller = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const runCount = useStreams((s) => runsInChannel(s, channel.id).length);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever rows are added
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [timeline, runCount]);

  const onSend = (text: string) => {
    stick.current = true;
    setDraft("");
    send(text);
  };

  const actions: ChannelActions = {
    insertMention: (handle) => {
      setDraft((d) => `${d.trim() ? `${d.trim()} ` : ""}@${handle} `);
      composer.current?.focus();
    },
    retry: (local) => {
      stick.current = true;
      retry(local);
    },
    resend: (body) => send(body),
    channelAgents,
  };

  const agentNames = joinNames(
    channelAgents.map((a) => a.name),
    t("newAgent.and"),
  );
  const subtitle = [
    channel.topic,
    channelAgents.length > 0 ? t("channel.agentsAnswer", { count: channelAgents.length, names: agentNames }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const stack = [...channelPeople.slice(0, 2), ...channelAgents.slice(0, 2)];
  const target = chrome?.composerTarget ?? `#${channel.name}`;

  return (
    <ChannelActionsContext.Provider value={actions}>
      <main className="shell__main shell__main--chat">
        {chrome?.header ?? (
          <header className="channel__header">
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <h1 className="channel__title"># {channel.name}</h1>
              {subtitle && <span className="channel__topic">{subtitle}</span>}
            </div>
            {stack.length > 0 && (
              <AvatarStack
                role="img"
                aria-label={t("channel.members", {
                  names: [...channelPeople, ...channelAgents].map((m) => m.name).join(", "),
                })}
              >
                {stack.map((m) =>
                  "handle" in m ? (
                    <Avatar key={m.id} kind="agent" size="sm" name={m.name} initials={dir.agentInitials(m.id)} />
                  ) : (
                    <Avatar key={m.userId} size="sm" name={m.name} imageUrl={m.image} />
                  ),
                )}
              </AvatarStack>
            )}
            <Button size="sm" onClick={() => setDetailsOpen(true)}>
              {t("channel.details")}
            </Button>
          </header>
        )}

        {!isMember ? (
          <div className="channel__empty">
            <EmptyState
              icon="channel"
              title={t("channel.notMemberTitle")}
              actions={
                <Button variant="primary" onClick={() => join.mutate()} disabled={join.isPending}>
                  {t("channel.join", { channel: channel.name })}
                </Button>
              }
            >
              {t("channel.notMemberText")}
            </EmptyState>
          </div>
        ) : (
          <>
            <section
              ref={scroller}
              className="channel__messages"
              aria-label={t("channel.messages")}
              aria-live="polite"
              aria-relevant="additions"
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {messages.isError && (
                <EmptyState icon="alert">
                  {messages.error instanceof ApiError ? messages.error.message : t("common.loadFailed")}
                </EmptyState>
              )}
              {messages.isSuccess && timeline.length === 0 && runCount === 0 && (
                <div className="channel__empty">
                  <EmptyState icon="message">{chrome?.emptyText ?? t("channel.empty")}</EmptyState>
                </div>
              )}
              <Timeline items={timeline} />
              <LiveMemoryCards channelId={channel.id} />
              <LiveRuns channelId={channel.id} />
            </section>
            {status === "reconnecting" && (
              <p className="channel__status" role="status">
                {t("channel.reconnecting")}
              </p>
            )}
            <div className="channel__composer">
              <TypingIndicator channelId={channel.id} />
              <Composer
                id={`composer-${channel.id}`}
                textareaRef={composer}
                value={draft}
                onChange={(v) => {
                  setDraft(v);
                  if (v.trim()) sendTyping();
                }}
                onSend={onSend}
                label={t("channel.composerLabel", { channel: target.replace(/^#/, "") })}
                placeholder={
                  chrome?.composerTarget
                    ? t("channel.composerLabel", { channel: target })
                    : t("channel.composerPlaceholder", { channel: channel.name })
                }
                sendLabel={t("channel.send")}
                attachLabel={t("channel.attach")}
              />
              <p className="ac-composer__hint">
                {channelAgents.length > 0
                  ? t("channel.footerAgents", { count: channelAgents.length, names: agentNames })
                  : t("channel.footerNoAgents")}
              </p>
            </div>
          </>
        )}

        {!chrome?.header && <ChannelDetails open={detailsOpen} onOpenChange={setDetailsOpen} channel={channel} />}
      </main>
    </ChannelActionsContext.Provider>
  );
}

/** Persisted rows. Memoized: streaming deltas don't re-render it. */
const Timeline = memo(function Timeline({ items }: { items: ReturnType<typeof buildTimeline> }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      {items.map((item) =>
        item.kind === "day" ? (
          <DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>
        ) : item.kind === "message" ? (
          <TimelineMessage key={item.key} message={item.message} grouped={item.grouped} />
        ) : null,
      )}
    </>
  );
});

/** `memory.updated` cards (live, they aren't in the message list). */
function LiveMemoryCards({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const cards = useLive((s) => s.memory[channelId]);
  return (
    <>
      {(cards ?? []).map((c) => {
        const name = dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent");
        return (
          <Message
            key={c.key}
            agent
            stacked
            avatar={<Avatar kind="agent" name={name} initials={dir.agentInitials(c.agentId)} />}
            author={name}
            time={t("common.now")}
          >
            <MemoryChangeCard update={c.update} agentId={c.agentId} />
          </Message>
        );
      })}
    </>
  );
}

/** Agents working right now: "Ada está pensando…", then the streaming text with the cursor. */
function LiveRuns({ channelId }: { channelId: string }) {
  const runs = useStreams((s) => runsInChannel(s, channelId), sameRuns);
  return (
    <>
      {runs.map((run) => (
        <LiveRunRow key={run.runId} run={run} />
      ))}
    </>
  );
}

const LiveRunRow = memo(function LiveRunRow({ run }: { run: LiveRun }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const dismissRun = useDismissRun();
  const agent = dir.agentById.get(run.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const failed = run.status === "failed";
  const thinking = run.status === "thinking" || (!run.text && !failed && run.status !== "waiting_approval");
  return (
    <Message
      agent
      streaming={!failed && !thinking}
      avatar={<Avatar kind="agent" name={name} initials={dir.agentInitials(run.agentId)} running={!failed} />}
      author={name}
      time={t("common.now")}
      meta={
        failed ? undefined : run.status === "waiting_approval" ? t("channel.waitingApproval") : t("channel.writing")
      }
      data-live={run.status}
    >
      {failed ? (
        <p className="ac-msg__error" role="alert">
          <Icon name="alert" size={18} />
          <span style={{ flex: 1 }}>
            {run.error
              ? t("channel.runFailed", { agent: name, reason: run.error })
              : t("channel.runFailedNoReason", { agent: name })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="close"
            aria-label={t("common.close")}
            onClick={() => dismissRun(run.runId)}
          />
        </p>
      ) : thinking ? (
        <p className="ac-msg__text muted" role="status">
          {t("channel.thinking", { name })}
        </p>
      ) : (
        <MessageText>
          <MessageBody body={run.text} resolveMention={dir.mentionName} />
        </MessageText>
      )}
    </Message>
  );
});

/** "Marina está digitando…" above the composer. */
function TypingIndicator({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [now, setNow] = useState(() => Date.now());
  const typing = useLive((s) => s.typing[channelId]);
  const ids = typingIn({ [channelId]: typing ?? {} }, channelId, now, me.user.id);
  useEffect(() => {
    if (!typing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [typing]);
  const names = ids.map((id) => dir.memberById.get(id)?.name).filter((n): n is string => Boolean(n));
  return (
    <p className="channel__typing" aria-live="polite">
      {names.length > 0 ? t("channel.typing", { count: names.length, names: joinNames(names, t("newAgent.and")) }) : ""}
    </p>
  );
}

/** One persisted row; agent replies get feedback actions, people's messages get receipts. */
const TimelineMessage = memo(function TimelineMessage({
  message: m,
  grouped,
}: {
  message: MessageType;
  grouped: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const [active, setActive] = useState(false);
  const agent = m.author.type === "agent" ? dir.agentById.get(m.author.id ?? "") : undefined;
  const person = m.author.type === "person" ? dir.memberById.get(m.author.id ?? "") : undefined;
  const name = dir.authorName(m.author);
  const meta = m.meta ?? {};
  const approvalId = typeof meta.approvalId === "string" ? meta.approvalId : null;
  const proposalId = typeof meta.proposalId === "string" ? meta.proposalId : null;
  const card = approvalId || proposalId;
  const feedback = m.author.type === "agent" && !card && !m.local;
  return (
    <Message
      agent={m.author.type === "agent"}
      grouped={grouped}
      className={m.local ? `ac-msg--local ac-msg--${m.local}` : undefined}
      onMouseEnter={feedback ? () => setActive(true) : undefined}
      onFocus={feedback ? () => setActive(true) : undefined}
      avatar={
        <Avatar
          kind={m.author.type}
          name={name}
          imageUrl={person?.image}
          initials={agent ? dir.agentInitials(agent.id) : undefined}
        />
      }
      author={name}
      time={<time dateTime={m.createdAt}>{formatTime(i18n.language, m.createdAt)}</time>}
      meta={m.local === "pending" ? t("channel.sending") : undefined}
      stacked={Boolean(card)}
    >
      {(m.body.trim() || !card) && (
        <MessageText>
          <MessageBody body={m.body} resolveMention={dir.mentionName} />
        </MessageText>
      )}
      {m.local === "failed" && (
        <p className="ac-msg__error" role="alert">
          <Icon name="alert" size={18} />
          <span>{t("channel.notSent")} ·</span>
          <button type="button" className="ac-link" onClick={() => actions?.retry(m)} style={inlineButton}>
            {t("channel.retrySend")}
          </button>
        </p>
      )}
      {approvalId && <MessageApproval approvalId={approvalId} agent={agent} members={dir.memberById} />}
      {proposalId && <InlineProposal proposalId={proposalId} />}
      {m.author.type === "person" && !m.local && <MessageReceipts message={m} />}
      {feedback && (
        <MessageFeedback messageId={m.id} agentName={agent?.name ?? t("channel.unknownAgent")} active={active} />
      )}
    </Message>
  );
});

const inlineButton = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
};

/** The card of a message with `meta.approvalId`: from the approvals list, or fetched by id. */
function MessageApproval({
  approvalId,
  agent,
  members,
}: {
  approvalId: string;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const listed: Approval | undefined = approvals.data?.find((a) => a.id === approvalId);
  const one = useApproval(org.id, approvalId, !listed && approvals.isSuccess);
  const approval = listed ?? one.data;
  if (!approval) return null;
  return <InlineApproval approval={approval} agent={agent} members={members} />;
}

/** "Detalhes do canal": who is here (roster), and the topic for admins. */
function ChannelDetails({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roster = useRoster(org.id, channel.id, open && channel.isMember);
  const update = useUpdateChannel(org.id, channel.id);
  const editable = can(org.role, "configure");
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState(channel.topic);
  useEffect(() => {
    if (open) setTopic(channel.topic);
  }, [open, channel.topic]);
  const needle = q.trim().toLowerCase();
  const rows = (roster.data ?? [])
    .map((m) => ({
      key: `${m.type}-${m.id}`,
      kind: m.type,
      name: m.name,
      sub: m.type === "agent" ? `@${m.handle ?? ""}` : (dir.memberById.get(m.id)?.email ?? ""),
      image: m.type === "person" ? (dir.memberById.get(m.id)?.image ?? null) : null,
      initials: m.type === "agent" ? dir.agentInitials(m.id) : undefined,
      autoReply: m.autoReply,
    }))
    .filter((r) => !needle || `${r.name} ${r.sub}`.toLowerCase().includes(needle));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("channel.detailsTitle", { channel: channel.name })}
      description={editable ? undefined : channel.topic || t("channel.noTopic")}
      closeLabel={t("common.close")}
    >
      {editable && (
        <form
          className="ac-dialog__tools row row--end"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ topic: topic.trim() });
          }}
        >
          <Field label={t("channel.topic")} id={`topic-${channel.id}`} style={{ flex: "1 1 260px" }}>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("channel.topicPlaceholder")}
            />
          </Field>
          <Button type="submit" disabled={update.isPending || topic.trim() === channel.topic}>
            {t("channel.saveTopic")}
          </Button>
        </form>
      )}
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("channel.detailsSearch")}
        searchPlaceholder={t("channel.detailsSearch")}
        isEmpty={roster.isSuccess && rows.length === 0}
        emptyText={t("channel.detailsEmpty", { q })}
      >
        {rows.map((r) => (
          <div key={r.key} className="member-row">
            <Avatar kind={r.kind} size="sm" name={r.name} imageUrl={r.image} initials={r.initials} />
            <span className="list-col">
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              <span className="small muted">{r.sub}</span>
            </span>
            {r.autoReply && <span className="small muted">{t("channel.autoReply")}</span>}
          </div>
        ))}
      </DialogSearchList>
      <div style={{ height: 20 }} />
    </Dialog>
  );
}

/** Link to an agent profile (DM header). */
export function AgentProfileLink({ agentId, label }: { agentId: string; label: string }) {
  const { org } = useOrg();
  return (
    <Button asChild size="sm">
      <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId }}>
        {label}
      </Link>
    </Button>
  );
}
