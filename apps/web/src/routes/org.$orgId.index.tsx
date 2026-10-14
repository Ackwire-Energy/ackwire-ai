import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { channelsQuery } from "@/api/queries";
import { EmptyPage } from "@/components/EmptyPage";
import { Main } from "@/components/Main";

/** `/org/$orgId` → #general (or the first channel you're in). */
export const Route = createFileRoute("/org/$orgId/")({
  beforeLoad: async ({ context, params }) => {
    const channels = await context.queryClient
      .ensureQueryData(channelsQuery(context.api, params.orgId))
      .catch(() => []);
    const home = channels.find((c) => c.name === "general" && c.isMember) ?? channels.find((c) => c.isMember);
    if (home) throw redirect({ to: "/org/$orgId/c/$channelId", params: { orgId: params.orgId, channelId: home.id } });
  },
  component: function NoChannel() {
    const { t } = useTranslation();
    return (
      <Main>
        <EmptyPage icon="channel" title={t("shell.channels")} text={t("channel.notMemberText")} />
      </Main>
    );
  },
});
