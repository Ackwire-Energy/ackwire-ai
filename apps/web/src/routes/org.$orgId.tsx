import { useMe } from "@agenteschat/client";
import { membershipIn } from "@agenteschat/client/lib/guards";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, EmptyState } from "@agenteschat/ui";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { requireUserIn } from "@/app/guards";
import { ArtifactViewerProvider } from "@/components/artifacts/ArtifactViewer";
import { CommandMenu } from "@/components/CommandMenu";
import { MenuBarActions } from "@/components/DesktopMenus";
import { DesktopTitleBar } from "@/components/DesktopTitleBar";
import { RefetchBar } from "@/components/Loading";
import { OutageNotices } from "@/components/MachineOutages";
import { NavDrawerProvider, NavScrim, ShellBar } from "@/components/NavDrawer";
import { OrgProvider } from "@/components/org-context";
import { Sidebar } from "@/components/Sidebar";
import { BootSplash } from "@/components/Sky";
import { inDesktopApp } from "@/lib/desktop";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { RealtimeProvider } from "@/realtime/context";

/** The workspace shell of an organization: sidebar + page, and its WebSocket. */
export const Route = createFileRoute("/org/$orgId")({
  beforeLoad: async ({ context, location, params }) => {
    const me = await requireUserIn(context, location.href, params.orgId);
    return { me, membership: membershipIn(me, params.orgId) };
  },
  component: OrgLayout,
  // Opening the workspace takes a moment (the session check): the sky rises meanwhile.
  pendingComponent: BootSplash,
});

function OrgLayout() {
  const loaded = Route.useRouteContext();
  const { orgId } = Route.useParams();
  // The cached person, so a new logo or workspace name shows at once, not at the next navigation.
  const me = useMe().data ?? loaded.me;
  const membership = membershipIn(me, orgId);
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // "Criar agente" is a focused flow with its own rail: no sidebar while it's open (admins only; others see why not).
  const focused = /\/agents\/new\/?$/.test(path) && can(membership?.role, "manage_agents");
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
          <NavDrawerProvider>
            {inDesktopApp() && <DesktopTitleBar />}
            {inDesktopApp() && <MenuBarActions orgId={membership.id} />}
            <div className="shell">
              <RefetchBar />
              <CommandMenu />
              {!focused && (
                <>
                  <NavScrim />
                  <Sidebar />
                  <ShellBar />
                </>
              )}
              {/* The work area: a notice on top when a computer the agents run on went offline, then the page. */}
              <div className="shell__work">
                {!focused && <OutageNotices />}
                <div className="shell__pages">
                  <Outlet />
                </div>
              </div>
            </div>
          </NavDrawerProvider>
        </ArtifactViewerProvider>
      </RealtimeProvider>
    </OrgProvider>
  );
}
