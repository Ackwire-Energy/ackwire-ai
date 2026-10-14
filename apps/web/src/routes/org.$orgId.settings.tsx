import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/** Organization settings: context, connectors, provider keys, usage. The OAuth callback returns here. */
export const Route = createFileRoute("/org/$orgId/settings")({
  validateSearch: (search: Record<string, unknown>): { connected?: string } => ({
    connected: typeof search.connected === "string" ? search.connected : undefined,
  }),
  component: function Settings() {
    return (
      <Main>
        <SettingsPage connected={Route.useSearch().connected} />
      </Main>
    );
  },
});
