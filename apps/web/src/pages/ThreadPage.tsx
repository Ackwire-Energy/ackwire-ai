import { EmptyState } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/http";
import { useThreadInfo } from "@/api/queries";
import { ErrorState } from "@/components/Loading";
import { Main } from "@/components/Main";
import { useOrg } from "@/components/org-context";
import { ArchivedNote, ContextBlock, ThreadHeader, ThreadOrigin } from "@/components/threads/ThreadView";
import { ChannelPage, ChannelSkeleton } from "./ChannelPage";

/**
 * A thread (ThreadContexto.html): its header, where it came from and its
 * context block on top, then its conversation with the channel's own rows,
 * live runs and composer (ChannelPage in thread mode). Archived: read only.
 */
export function ThreadPage({ threadId, reply }: { threadId: string; reply?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const info = useThreadInfo(org.id, threadId);
  const thread = info.data;
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
            <ThreadOrigin thread={thread} />
            <ContextBlock thread={thread} />
          </>
        ),
        composerLabel: t("threads.view.composer"),
        composerReplacement: archived ? <ArchivedNote thread={thread} /> : undefined,
      }}
    />
  );
}
