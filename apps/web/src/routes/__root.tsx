import { Button, EmptyState } from "@agenteschat/ui";
import { createRootRouteWithContext, Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { RouterContext } from "@/app/router-context";
import { ContextMenuHost } from "@/components/DesktopMenus";
import { DesktopDragStrip } from "@/components/DesktopTitleBar";
import { inDesktopApp, pageReady } from "@/lib/desktop";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  // agentes for Mac: the workspace has its title bar (org.$orgId.tsx); every other page drags from the top.
  const inWorkspace = useRouterState({ select: (s) => s.location.pathname.startsWith("/org/") });
  const router = useRouter();
  // In the app: once this first screen is on the glass, the app's cover over the window goes.
  useEffect(() => {
    if (inDesktopApp()) requestAnimationFrame(() => requestAnimationFrame(pageReady));
  }, []);
  // The app opens a page of the site that is already open (the tray, a notification, ⌘-click) without
  // loading it again: the route moves (main_window.rs). Downloads and the API go as a plain load.
  useEffect(() => {
    if (!inDesktopApp()) return;
    const w = window as { __agentesNavigate?: (path: string) => void };
    w.__agentesNavigate = (path) => {
      if (!path.startsWith("/") || path.startsWith("//")) return;
      if (path.startsWith("/api/")) window.location.assign(path);
      else router.history.push(path);
    };
    return () => {
      delete w.__agentesNavigate;
    };
  }, [router]);
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
