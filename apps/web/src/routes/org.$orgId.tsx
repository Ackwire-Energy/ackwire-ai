import { Button, EmptyState } from "@agenteschat/ui";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { requireUser } from "@/app/guards";
import { ArtifactViewerProvider } from "@/components/artifacts/ArtifactViewer";
import { OrgProvider } from "@/components/org-context";
import { Sidebar } from "@/components/Sidebar";
import { membershipIn } from "@/lib/guards";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { RealtimeProvider } from "@/realtime/context";

/** The workspace shell of an organization: sidebar + page, and its WebSocket. */
export const Route = createFileRoute("/org/$orgId")({
  beforeLoad: async ({ context, location, params }) => {
    const me = await requireUser(context, location.href);
    return { me, membership: membershipIn(me, params.orgId) };
  },
  component: OrgLayout,
});

function OrgLayout() {
  const { me, membership } = Route.useRouteContext();
  const { t } = useTranslation();
  useEffect(() => {
    if (membership) storage.set(STORAGE_KEYS.lastOrg, membership.id);
  }, [membership]);

  if (!membership) {
    return (
      <div className="page page--mid">
        <header className="page__header">
          <h1 className="page-title">{t("empty.noOrgTitle")}</h1>
        </header>
        <EmptyState
          icon="members"
          actions={
            <Button asChild>
              <Link to="/">{t("empty.goHome")}</Link>
            </Button>
          }
        >
          {t("empty.noOrgText")}
        </EmptyState>
      </div>
    );
  }

  return (
    <OrgProvider org={membership} me={me}>
      <RealtimeProvider orgId={membership.id}>
        <ArtifactViewerProvider>
          <div className="shell">
            <Sidebar />
            <Outlet />
          </div>
        </ArtifactViewerProvider>
      </RealtimeProvider>
    </OrgProvider>
  );
}
