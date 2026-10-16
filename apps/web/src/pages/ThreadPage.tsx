import { EmptyState } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/http";
import { useThreadMission } from "@/api/missions";
import { useThreadInfo } from "@/api/queries";
import { ErrorState } from "@/components/Loading";
import { Main } from "@/components/Main";
import { MissionJoinNote, MissionPinned } from "@/components/missions/MissionPinned";
import { useOrg } from "@/components/org-context";
import { ArchivedNote, ContextBlock, ThreadHeader, ThreadOrigin } from "@/components/threads/ThreadView";
import { isOpenMission } from "@/lib/missions";
import { ChannelPage, ChannelSkeleton } from "./ChannelPage";

/**
 * A thread (ThreadContexto.html): its header, where it came from and its
 * context block on top, then its conversation with the channel's own rows,
 * live runs and composer (ChannelPage in thread mode). Archived: read only.
 * A mission's thread has the mission pinned on top (ThreadContexto.html, "App mobile").
 */
export function ThreadPage({
  threadId,
  reply,
  focusMessageId,
}: {
  threadId: string;
  reply?: boolean;
  /** Open at this message (a card someone was sent to). */
  focusMessageId?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const info = useThreadInfo(org.id, threadId);
  const thread = info.data;
  // A thread with a mission (ADR 0029): the mission pinned on top; who only reads gets a note.
  const mission = useThreadMission(org.id, threadId).data ?? null;
  const channelId = thread?.channelId;
  // "Responder" on a closed thread's line: straight to the composer.
  useEffect(() => {
    if (!reply || !channelId) return;
    const timer = setTimeout(() => document.getElementById(`composer-${channelId}`)?.focus(), 80);
    return () => clearTimeout(timer);
  }, [reply, channelId]);
  if (info.isPending) return <ChannelSkeleton />;
  if (!thread) {
    if (info.error instanceof ApiError && (info.error.status === 404 || info.error.status === 403)) {
      return (
        <Main>
          <div className="page page--mid">
            <EmptyState icon="thread" title={t("threads.view.notFoundTitle")}>
              {t("threads.view.notFound")}
            </EmptyState>
          </div>
        </Main>
      );
    }
    return (
      <Main>
        <ErrorState error={info.error} onRetry={() => void info.refetch()} />
      </Main>
    );
  }
  const archived = thread.state === "archived";
  return (
    <ChannelPage
      channelId={thread.channelId}
      thread={thread}
      focusMessageId={focusMessageId}
      // A DM isn't in the channel list: the thread's own view of where it lives is enough here.
      fallback={{
        id: thread.channelId,
        name: thread.channelName,
        topic: "",
        visibility: "private",
        isMember: true,
        createdAt: thread.createdAt,
      }}
      chrome={{
        header: <ThreadHeader thread={thread} />,
        top: (
          <>
            {mission && <MissionPinned mission={mission} />}
            <ThreadOrigin thread={thread} />
            <ContextBlock thread={thread} />
          </>
        ),
        composerNote:
          mission && isOpenMission(mission) && mission.role === "none" ? (
            <MissionJoinNote mission={mission} />
          ) : undefined,
        composerLabel: t("threads.view.composer"),
        composerReplacement: archived ? <ArchivedNote thread={thread} /> : undefined,
      }}
    />
  );
}
