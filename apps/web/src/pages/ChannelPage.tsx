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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/http";
import {
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
import { MessageBody } from "@/chat/MessageBody";
import { buildTimeline, mergeTimeline, threadRootsToLoad } from "@/chat/timeline";
import { InlineApproval } from "@/components/ApprovalItem";
import { MessageFeedback } from "@/components/MessageFeedback";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { dayLabel, formatTime, joinNames } from "@/lib/format";
import { can } from "@/lib/permissions";
import { useChannelRealtime, useConnectionStatus, useDismissRun, useStreams } from "@/realtime/context";
import { runsInChannel } from "@/realtime/streams";

/** telas/Main.dc.html — a channel with real-time messages, streaming agent replies and inline approvals. */
export function ChannelPage({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const channel = channels.data?.find((c) => c.id === channelId);

  if (channels.isPending) return <main className="shell__main shell__main--chat" aria-busy="true" />;
  if (!channel) {
    return (
      <main className="shell__main">
        <div className="page page--mid">
          <EmptyState icon="channel">{t("channel.notFound")}</EmptyState>
        </div>
      </main>
    );
  }
  return <ChannelView key={channel.id} channel={channel} />;
}

function ChannelView({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const isMember = channel.isMember;
  const members = useChannelMembers(org.id, channel.id, isMember);
  const messages = useMessages(org.id, channel.id, isMember);
  const roots = useMemo(() => threadRootsToLoad(messages.data ?? []), [messages.data]);
  const threads = useThreads(org.id, channel.id, isMember ? roots : []);
  const runs = useStreams((s) => runsInChannel(s, channel.id));
  const dismissRun = useDismissRun();
  const status = useConnectionStatus();
  const post = usePostMessage(org.id, channel.id);
  const join = useJoinChannel(org.id, channel.id);
  const [draft, setDraft] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  const agentNames = joinNames(
    channelAgents.map((a) => a.name),
    t("newAgent.and"),
  );

  const timeline = useMemo(
    () =>
      buildTimeline(
        mergeTimeline(
          messages.data ?? [],
          threads.map((q) => q.data),
        ),
        [],
        runs,
      ),
    [messages.data, threads, runs],
  );

  // Keep the newest message in view while the person is at the bottom.
  const scroller = useRef<HTMLElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the rows change
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  const send = (text: string) => {
    stick.current = true;
    setDraft("");
    post.mutate(text, { onError: () => setDraft(text) });
  };

  const subtitle = [
    channel.topic,
    channelAgents.length > 0 ? t("channel.agentsAnswer", { count: channelAgents.length, names: agentNames }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const stack = [...channelPeople.slice(0, 2), ...channelAgents.slice(0, 2)];

  return (
    <main className="shell__main shell__main--chat">
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
            {messages.isSuccess && timeline.length === 0 && (
              <div className="channel__empty">
                <EmptyState icon="message">{t("channel.empty")}</EmptyState>
              </div>
            )}
            {timeline.map((item) => {
              switch (item.kind) {
                case "day":
                  return <DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>;
                case "message":
                  return <TimelineMessage key={item.key} message={item.message} grouped={item.grouped} />;
                case "run": {
                  const run = item.run;
                  const agent = dir.agentById.get(run.agentId);
                  const name = agent?.name ?? t("channel.unknownAgent");
                  const failed = run.status === "failed";
                  return (
                    <Message
                      key={item.key}
                      agent
                      streaming={!failed}
                      avatar={
                        <Avatar kind="agent" name={name} initials={dir.agentInitials(run.agentId)} running={!failed} />
                      }
                      author={name}
                      time={t("common.now")}
                      meta={
                        failed
                          ? undefined
                          : run.status === "waiting_approval"
                            ? t("channel.waitingApproval")
                            : t("channel.writing")
                      }
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
                      ) : (
                        <MessageText>
                          <MessageBody body={run.text} resolveMention={dir.mentionName} />
                        </MessageText>
                      )}
                    </Message>
                  );
                }
                default:
                  return null;
              }
            })}
          </section>
          {status === "reconnecting" && (
            <p className="channel__status" role="status">
              {t("channel.reconnecting")}
            </p>
          )}
          <div className="channel__composer">
            <Composer
              id={`composer-${channel.id}`}
              value={draft}
              onChange={setDraft}
              onSend={send}
              label={t("channel.composerLabel", { channel: channel.name })}
              placeholder={t("channel.composerPlaceholder", { channel: channel.name })}
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

      <ChannelDetails open={detailsOpen} onOpenChange={setDetailsOpen} channel={channel} />
    </main>
  );
}

/** One message row; agent replies get feedback actions (👍/👎, "Corrigir resposta"). */
function TimelineMessage({ message: m, grouped }: { message: MessageType; grouped: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const approvals = useApprovals(org.id);
  const [active, setActive] = useState(false);
  const agent = m.author.type === "agent" ? dir.agentById.get(m.author.id ?? "") : undefined;
  const person = m.author.type === "person" ? dir.memberById.get(m.author.id ?? "") : undefined;
  const name = dir.authorName(m.author);
  const approvalId = typeof m.meta?.approvalId === "string" ? m.meta.approvalId : null;
  const feedback = m.author.type === "agent" && !approvalId;
  return (
    <Message
      agent={m.author.type === "agent"}
      grouped={grouped}
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
      stacked={approvalId !== null}
    >
      {(m.body.trim() || !approvalId) && (
        <MessageText>
          <MessageBody body={m.body} resolveMention={dir.mentionName} />
        </MessageText>
      )}
      {approvalId && (
        <MessageApproval
          approvalId={approvalId}
          listed={approvals.data?.find((a) => a.id === approvalId)}
          agent={agent}
          members={dir.memberById}
        />
      )}
      {feedback && (
        <MessageFeedback messageId={m.id} agentName={agent?.name ?? t("channel.unknownAgent")} active={active} />
      )}
    </Message>
  );
}

/** The card of a message with `meta.approvalId`: from the approvals list, or fetched by id. */
function MessageApproval({
  approvalId,
  listed,
  agent,
  members,
}: {
  approvalId: string;
  listed: Approval | undefined;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { org } = useOrg();
  const one = useApproval(org.id, approvalId, !listed);
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
