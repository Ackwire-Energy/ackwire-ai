import { createFileRoute, redirect } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";
import { isSettingsSection, settingsSearch } from "@/pages/settings-sections";

/** One settings section per URL: `/settings/connectors` (OAuth returns here with `?connected`/`?review=1`/`?mail`). */
export const Route = createFileRoute("/org/$orgId/settings_/$section")({
  validateSearch: settingsSearch,
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) {
      throw redirect({ to: "/org/$orgId/settings", params: { orgId: params.orgId } });
    }
  },
  component: function SettingsSectionRoute() {
    const { section } = Route.useParams();
    const { connected, outcome, review, mail, account, install } = Route.useSearch();
    return (
      <Main>
        <SettingsPage
          section={isSettingsSection(section) ? section : "general"}
          connected={connected}
          outcome={outcome}
          review={review !== undefined}
          mail={mail}
          account={account}
          install={install}
        />
      </Main>
    );
  },
});
