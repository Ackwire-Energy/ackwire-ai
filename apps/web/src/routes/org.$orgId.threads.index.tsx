import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { THREAD_TABS, ThreadsPage, type ThreadsTab } from "@/pages/ThreadsPage";

/** Threads (telas/Threads.html): `?tab=` and `?channel=` (from a channel's "Threads (N)"). */
export const Route = createFileRoute("/org/$orgId/threads/")({
  validateSearch: (search: Record<string, unknown>): { tab?: ThreadsTab; channel?: string } => ({
    ...(THREAD_TABS.includes(search.tab as ThreadsTab) ? { tab: search.tab as ThreadsTab } : {}),
    ...(typeof search.channel === "string" && search.channel ? { channel: search.channel } : {}),
  }),
  component: function Threads() {
    const { tab, channel } = Route.useSearch();
    return (
      <Main>
        <ThreadsPage key={`${tab ?? ""}:${channel ?? ""}`} initialTab={tab} initialChannel={channel} />
      </Main>
    );
  },
});
