import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { fireEvent } from "@testing-library/react";
import { movesByKeys, trackInput } from "../src";

afterEach(() => {
  document.body.innerHTML = "";
});

const styles = (name: string) => Bun.file(new URL(`../src/styles/${name}`, import.meta.url).pathname).text();

describe("focus rings only for the keys", () => {
  test("Tab, or a moving key where nothing is typed, turns them on; a press turns them off; typing changes nothing", () => {
    trackInput();
    const html = document.documentElement;
    document.body.innerHTML = '<button type="button">Ver perfil</button><textarea></textarea><input type="radio">';
    const el = (selector: string) => document.querySelector(selector) as HTMLElement;
    const [button, box, radio] = [el("button"), el("textarea"), el("input")];
    const mode = () => [html.hasAttribute("data-pointer") ? "pointer" : "keys", movesByKeys()];
    expect(mode()).toEqual(["pointer", false]);
    // Typing, the caret, sending, closing, a shortcut: still the pointer's.
    for (const key of ["a", "ArrowDown", "Home", "Enter"]) fireEvent.keyDown(box, { key });
    fireEvent.keyDown(button, { key: "Escape" });
    fireEvent.keyDown(button, { key: "ArrowDown", metaKey: true });
    expect(mode()).toEqual(["pointer", false]);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(mode()).toEqual(["keys", true]);
    fireEvent.pointerDown(button, { pointerType: "touch" });
    expect(mode()).toEqual(["pointer", false]);
    // Arrows between radios move the focus; ⌥Tab is how Safari reaches a button.
    fireEvent.keyDown(radio, { key: "ArrowRight" });
    expect(mode()).toEqual(["keys", true]);
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    fireEvent.keyDown(button, { key: "Tab", altKey: true });
    expect(mode()).toEqual(["keys", true]);
  });

  test("the ring is a gray one a pixel off the control; while the pointer leads, not even the browser's own", async () => {
    const tokens = await styles("tokens.css");
    expect(tokens).toContain("--focus-color: var(--line-strong);");
    expect(tokens).toContain("--focus-ring: 0 0 0 1px var(--raised), 0 0 0 3px var(--focus-color);");
    const css = await styles("components.css");
    expect(css).toContain("html[data-pointer] :focus-visible {\n  outline: none;\n}");
    // Nothing focused by the keys keeps the browser's own ring.
    expect(css).toContain(
      ":where(html:not([data-pointer])) :where(:focus-visible) {\n  outline: 2px solid var(--focus-color);\n  outline-offset: 1px;\n}",
    );
    expect(css).toContain(
      "html:not([data-pointer]) .ac-btn:focus-visible {\n  outline: none;\n  box-shadow: var(--focus-ring);",
    );
  });
});
