import { MenuAt, MenuHeading, MenuItem, MenuReactions, MenuSeparator } from "@agenteschat/ui";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  copyText,
  keepsSystemMenu,
  type MenuEntry,
  type OpenMenu,
  openContextMenu,
  setMenuHost,
} from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { openPalette } from "./CommandMenu";
import { NEW_CHANNEL_EVENT, toggleSidebar } from "./Sidebar";

/**
 * The desktop app's right click (telas/MenusDesktop.html): draws our menu when a screen opens one, and gives
 * links and empty space theirs. Mounted only in the app (__root.tsx); typing and selected text keep the
 * system's menu.
 */
export function ContextMenuHost() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    setMenuHost(setOpen);
    return () => setMenuHost(null);
  }, []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || keepsSystemMenu(e.target)) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      const entries: MenuEntry[] = link ? linkEntries(link) : pageEntries();
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, entries);
    };
    const linkEntries = (link: HTMLAnchorElement): MenuEntry[] => {
      const url = new URL(link.href, window.location.href);
      const here = url.origin === window.location.origin;
      return [
        { kind: "header", label: here ? url.pathname : url.host },
        here
          ? { kind: "item", id: "open", label: t("contextMenu.open"), icon: "arrowRight", run: () => link.click() }
          : {
              kind: "item",
              id: "open",
              label: t("contextMenu.openInBrowser"),
              icon: "external",
              // A new window: the app sends it to the browser (main_window.rs).
              run: () => window.open(url.href, "_blank", "noopener"),
            },
        {
          kind: "item",
          id: "copy-link",
          label: t("contextMenu.copyLink"),
          icon: "link",
          run: () => void copyText(url.href, () => toast.show(t("contextMenu.linkCopied"))),
        },
      ];
    };
    const pageEntries = (): MenuEntry[] => [
      { kind: "item", id: "back", label: t("contextMenu.back"), icon: "chevronLeft", run: () => router.history.back() },
      {
        kind: "item",
        id: "forward",
        label: t("contextMenu.forward"),
        icon: "chevronRight",
        run: () => router.history.forward(),
      },
      { kind: "item", id: "reload", label: t("contextMenu.reload"), icon: "refresh", run: () => location.reload() },
      ...(window.location.pathname.startsWith("/org/")
        ? ([
            { kind: "separator" },
            { kind: "item", id: "search", label: t("contextMenu.search"), icon: "search", run: openPalette },
          ] satisfies MenuEntry[])
        : []),
    ];
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [t, router, toast]);

  if (!open) return null;
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <MenuAt key={open.key} at={open} onClose={close} label={t("contextMenu.label")}>
      {open.entries.map((e, i) => {
        const key = e.kind === "item" ? e.id : `${e.kind}-${i}`;
        if (e.kind === "separator") return <MenuSeparator key={key} />;
        if (e.kind === "header") return <MenuHeading key={key}>{e.label}</MenuHeading>;
        if (e.kind === "reactions") {
          const pick = e.pick;
          return (
            <MenuReactions key={key} label={e.label} emojis={e.emojis} onPick={(emoji) => run(() => pick(emoji))()} />
          );
        }
        return (
          <MenuItem key={key} icon={e.icon} danger={e.danger} disabled={e.disabled} onSelect={run(e.run)}>
            {e.label}
          </MenuItem>
        );
      })}
    </MenuAt>
  );
}

/** The site's own keys for menu bar items: when both fire, the menu's echo is dropped. */
const OWN_KEYS: Record<string, string> = { k: "search", "[": "back", "]": "forward" };
const ECHO_MS = 400;

/**
 * The Mac's menu bar choices that are the site's (menus.rs `SITE_ACTIONS`): the app calls
 * `window.__agentesMenu(action)`. Mounted in the workspace, where they make sense.
 */
export function MenuBarActions({ orgId }: { orgId: string }) {
  const router = useRouter();
  useEffect(() => {
    const keyed = new Map<string, number>();
    const onKey = (e: KeyboardEvent) => {
      const action = e.metaKey ? OWN_KEYS[e.key.toLowerCase()] : undefined;
      if (action) keyed.set(action, performance.now());
    };
    const to = (path: string) => () => router.history.push(path);
    const org = `/org/${orgId}`;
    const actions: Record<string, () => void> = {
      newChannel: () => window.dispatchEvent(new Event(NEW_CHANNEL_EVENT)),
      newAgent: to(`${org}/agents/new`),
      search: openPalette,
      back: () => router.history.back(),
      forward: () => router.history.forward(),
      toggleSidebar,
      goHome: to(org),
      goWaiting: to(`${org}/notifications`),
      goTasks: to(`${org}/issues`),
      goWiki: to(`${org}/wiki`),
      goDrive: to(`${org}/drive`),
      orgSettings: to(`${org}/settings`),
    };
    const w = window as { __agentesMenu?: (action: string) => void };
    w.__agentesMenu = (action) => {
      if (performance.now() - (keyed.get(action) ?? -Infinity) < ECHO_MS) return;
      actions[action]?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      delete w.__agentesMenu;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [router, orgId]);
  return null;
}
