import { createFileRoute, redirect } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { isSettingsSection, SettingsPage, settingsSearch } from "@/pages/SettingsPage";

/** One settings section per URL: `/settings/connectors` (OAuth returns here with `?connected`/`?review=1`). */
export const Route = createFileRoute("/org/$orgId/settings_/$section")({
  validateSearch: settingsSearch,
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) {
      throw redirect({ to: "/org/$orgId/settings", params: { orgId: params.orgId } });
    }
  },
  component: function SettingsSectionRoute() {
    const { section } = Route.useParams();
    const { connected, review } = Route.useSearch();
    return (
      <Main>
        <SettingsPage
          section={isSettingsSection(section) ? section : "general"}
          connected={connected}
          review={review !== undefined}
        />
      </Main>
    );
  },
});
