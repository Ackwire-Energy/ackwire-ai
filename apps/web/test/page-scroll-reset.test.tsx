import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { pageScrollReset } from "../src/lib/page-scroll";
import { settle } from "./render";

afterEach(() => cleanup());

// Two settings sections in one route and a page of its own, each in the app's page column, routed like main.tsx.
async function app() {
  const root = createRootRoute({ component: Outlet });
  const page = () => <main className="shell__main" />;
  const section = createRoute({ getParentRoute: () => root, path: "settings/$section", component: page });
  const drive = createRoute({
    getParentRoute: () => root,
    path: "drive",
    component: page,
    validateSearch: (s: Record<string, unknown>) => ({ open: typeof s.open === "string" ? s.open : undefined }),
  });
  const pageScroll = pageScrollReset();
  const router = createRouter({
    routeTree: root.addChildren([section, drive]),
    history: createMemoryHistory({ initialEntries: ["/settings/members"] }),
    scrollRestoration: true,
    scrollToTopSelectors: pageScroll.selectors,
  });
  router.subscribe("onBeforeLoad", pageScroll.track);
  render(<RouterProvider router={router} />);
  await settle();
  const column = () => document.querySelector("main.shell__main") as HTMLElement;
  const scroll = (top: number) => {
    column().scrollTop = top;
    column().dispatchEvent(new Event("scroll"));
  };
  const go = async (to: () => unknown) => {
    await act(async () => {
      await to();
    });
    await settle();
  };
  return { router, column, scroll, go };
}

describe("page column scroll", () => {
  test("another settings section starts at the top, and Back puts the first one back where it was", async () => {
    const { router, column, scroll, go } = await app();
    scroll(600);
    await go(() => router.history.push("/settings/agents"));
    expect(column().scrollTop).toBe(0);
    await go(() => router.history.back());
    expect(column().scrollTop).toBe(600);
  });

  test("another page starts at the top too", async () => {
    const { router, column, scroll, go } = await app();
    scroll(400);
    await go(() => router.history.push("/drive"));
    expect(column().scrollTop).toBe(0);
  });

  test("a change of search alone (a dialog over the list) keeps the place", async () => {
    const { router, column, scroll, go } = await app();
    await go(() => router.history.push("/drive"));
    scroll(300);
    await go(() => router.history.replace("/drive?open=x"));
    expect(column().scrollTop).toBe(300);
  });
});
