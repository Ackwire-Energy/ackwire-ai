import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/**
 * Organization settings: context, connectors, provider keys, usage. The OAuth
 * callback returns here (`?connected=github`; a custom MCP server also brings
 * `?review=1` so its classification opens right away).
 */
export const Route = createFileRoute("/org/$orgId/settings")({
  validateSearch: (search: Record<string, unknown>): { connected?: string; review?: string } => ({
    connected: typeof search.connected === "string" ? search.connected : undefined,
    review: search.review === undefined ? undefined : String(search.review),
  }),
  component: function Settings() {
    const { connected, review } = Route.useSearch();
    return (
      <Main>
        <SettingsPage connected={connected} review={review !== undefined} />
      </Main>
    );
  },
});
