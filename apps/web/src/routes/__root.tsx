import { Button, EmptyState } from "@agenteschat/ui";
import { createRootRouteWithContext, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { RouterContext } from "@/app/router-context";
import { ContextMenuHost } from "@/components/DesktopMenus";
import { DesktopDragStrip } from "@/components/DesktopTitleBar";
import { inDesktopApp } from "@/lib/desktop";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  // agentes for Mac: the workspace has its title bar (org.$orgId.tsx); every other page drags from the top.
  const inWorkspace = useRouterState({ select: (s) => s.location.pathname.startsWith("/org/") });
  return (
    <>
      {inDesktopApp() && !inWorkspace && <DesktopDragStrip />}
      {inDesktopApp() && <ContextMenuHost />}
      <Outlet />
    </>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="page page--mid">
      <header className="page__header">
        <h1 className="page-title">{t("empty.notFoundTitle")}</h1>
      </header>
      <EmptyState
        icon="search"
        actions={
          <Button asChild>
            <Link to="/">{t("empty.goHome")}</Link>
          </Button>
        }
      >
        {t("empty.notFoundText")}
      </EmptyState>
    </div>
  );
}
