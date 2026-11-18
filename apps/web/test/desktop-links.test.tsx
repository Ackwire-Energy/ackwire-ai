import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { OpenPage } from "@/components/ai/AddAccountFlow";
import { routeNewWindowLinks } from "@/lib/desktop";

/**
 * A link that opens a new window, in the desktop app: the site sends it to `window.open` (the window's
 * `on_new_window` takes it from there, main_window.rs) before the shell plugin's listener on `body`, there since
 * the page loaded, can take it and ask the app over IPC, which the site may not do.
 */

let root: HTMLElement;
let layer: HTMLElement;
let opened: string[];
let pluginSaw: string[];
let stop: () => void;
let realOpen: typeof window.open;
const plugin = (e: Event) => {
  const link = (e.target as Element).closest("a");
  if (link) pluginSaw.push(link.href);
  e.preventDefault();
};

beforeEach(() => {
  realOpen = window.open;
  opened = [];
  pluginSaw = [];
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;
  // The React root, and what the site lays over it in `body` (a dialog, a popover, a toast).
  root = document.createElement("div");
  layer = document.createElement("div");
  document.body.append(root, layer);
  document.body.addEventListener("click", plugin);
  stop = routeNewWindowLinks();
});

afterEach(() => {
  cleanup();
  stop();
  document.body.removeEventListener("click", plugin);
  root.remove();
  layer.remove();
  window.open = realOpen;
  delete (window as { __agentesDesktop?: unknown }).__agentesDesktop;
});

function link(href: string, target?: string, parent = root) {
  const a = document.createElement("a");
  a.href = href;
  if (target) a.target = target;
  a.textContent = "link";
  parent.append(a);
  return a;
}

const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(e);
  return e;
};

describe("links that open a new window in the app", () => {
  test("go to window.open, and the plugin never sees them", () => {
    const e = click(link("https://example.com/", "_blank"));
    expect(opened).toEqual(["https://example.com/"]);
    expect(e.defaultPrevented).toBe(true);
    expect(pluginSaw).toEqual([]);
  });

  test("in what the site lays over the page in body too", () => {
    const e = click(link("https://example.com/help", "_blank", layer));
    expect(opened).toEqual(["https://example.com/help"]);
    expect(e.defaultPrevented).toBe(true);
    expect(pluginSaw).toEqual([]);
  });

  test("the words inside a link count as the link", () => {
    const a = link("mailto:dev@example.com", "_blank");
    const word = document.createElement("span");
    a.replaceChildren(word);
    const e = click(word);
    expect(e.defaultPrevented).toBe(true);
    // happy-dom runs the link's own default action at the link, while the click still bubbles up to the root, so
    // it opens there too. A browser runs it after the dispatch, where the root's preventDefault stops it.
    expect(opened).toContain("mailto:dev@example.com");
  });

  test("a click the page already handled (a popup) is left alone, and the plugin never sees it either", () => {
    for (const parent of [root, layer]) {
      const a = link("https://example.com/sign-in", "_blank", parent);
      a.addEventListener("click", (e) => e.preventDefault());
      click(a);
    }
    expect(opened).toEqual([]);
    expect(pluginSaw).toEqual([]);
  });

  test("one in a dialog that handles its own click (a maker's page) does it first, then opens once", () => {
    (window as { __agentesDesktop?: unknown }).__agentesDesktop = { version: "1", platform: "mac" };
    let handled = 0;
    render(
      createPortal(
        <OpenPage href="https://example.com/keys" onOpened={() => handled++}>
          Open
        </OpenPage>,
        document.body,
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "Open" }));
    expect(handled).toBe(1);
    expect(opened).toEqual(["https://example.com/keys"]);
    expect(pluginSaw).toEqual([]);
  });

  test("links that stay in the window, other buttons and other schemes are left alone", () => {
    click(link("https://example.com/page"));
    click(link("https://example.com/", "_blank"), { button: 1 });
    click(link("blob:https://example.com/1234", "_blank"));
    expect(opened).toEqual([]);
  });

  test("stops when the page goes", () => {
    stop();
    click(link("https://example.com/", "_blank"));
    expect(opened).toEqual([]);
    expect(pluginSaw).toEqual(["https://example.com/"]);
  });
});
