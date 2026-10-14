import {
  Avatar,
  AvatarStack,
  Button,
  Composer,
  DayDivider,
  Dialog,
  DialogSearchList,
  EmptyState,
  Icon,
  Message,
  MessageText,
} from "@agenteschat/ui";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/http";
import {
  useApprovals,
  useChannelMembers,
  useChannels,
  useJoinChannel,
  useMessages,
  usePostMessage,
  useThreads,
} from "@/api/queries";
import type { Agent, Channel, Member } from "@/api/types";
import { MessageBody } from "@/chat/MessageBody";
import { buildTimeline, mergeTimeline, threadRootsToLoad } from "@/chat/timeline";
import { InlineApproval } from "@/components/ApprovalItem";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { dayLabel, formatTime, joinNames } from "@/lib/format";
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
  const approvals = useApprovals(org.id);
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
        (approvals.data ?? []).filter((a) => a.channelId === channel.id),
        runs,
      ),
    [messages.data, threads, approvals.data, channel.id, runs],
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
                case "message": {
                  const m = item.message;
                  const agent = m.author.type === "agent" ? dir.agentById.get(m.author.id ?? "") : undefined;
                  const person = m.author.type === "person" ? dir.memberById.get(m.author.id ?? "") : undefined;
                  const name = dir.authorName(m.author);
                  return (
                    <Message
                      key={item.key}
                      agent={m.author.type === "agent"}
                      grouped={item.grouped}
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
                    >
                      <MessageText>
                        <MessageBody body={m.body} resolveMention={dir.mentionName} />
                      </MessageText>
                    </Message>
                  );
                }
                case "approval": {
                  const agent = dir.agentById.get(item.approval.agentId);
                  const name = agent?.name ?? t("channel.unknownAgent");
                  return (
                    <Message
                      key={item.key}
                      agent
                      stacked
                      avatar={<Avatar kind="agent" name={name} initials={dir.agentInitials(item.approval.agentId)} />}
                      author={name}
                      time={formatTime(i18n.language, item.approval.createdAt)}
                    >
                      <InlineApproval approval={item.approval} agent={agent} />
                    </Message>
                  );
                }
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

      <ChannelDetails
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        channel={channel}
        people={channelPeople}
        agents={channelAgents}
      />
    </main>
  );
}

/** "Detalhes do canal": who is here, in a searchable list. */
function ChannelDetails({
  open,
  onOpenChange,
  channel,
  people,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
  people: Member[];
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = [
    ...people.map((p) => ({ key: p.userId, kind: "person" as const, name: p.name, sub: p.email, image: p.image })),
    ...agents.map((a) => ({ key: a.id, kind: "agent" as const, name: a.name, sub: `@${a.handle}`, image: null })),
  ].filter((r) => !needle || `${r.name} ${r.sub}`.toLowerCase().includes(needle));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("channel.detailsTitle", { channel: channel.name })}
      description={channel.topic || t("channel.noTopic")}
      closeLabel={t("common.close")}
    >
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("channel.detailsSearch")}
        searchPlaceholder={t("channel.detailsSearch")}
        isEmpty={rows.length === 0}
        emptyText={t("channel.detailsEmpty", { q })}
      >
        {rows.map((r) => (
          <div key={r.key} className="member-row">
            <Avatar kind={r.kind} size="sm" name={r.name} imageUrl={r.image} />
            <span className="list-col">
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              <span className="small muted">{r.sub}</span>
            </span>
          </div>
        ))}
      </DialogSearchList>
      <div style={{ height: 20 }} />
    </Dialog>
  );
}
