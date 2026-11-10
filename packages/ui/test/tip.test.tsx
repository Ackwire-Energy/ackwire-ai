import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render } from "@testing-library/react";
import { Tip } from "../src/components/Tip";

const tip = () => document.querySelector(".ac-tip");
const pressEscape = () => act(async () => fireEvent.keyDown(window, { key: "Escape" }));

describe("a tip closes with Escape, without moving the pointer or the focus", () => {
  test("one the keys' focus opened", async () => {
    const { container, unmount } = render(
      <Tip tip="sábado, 7 de novembro de 2026 às 23:40" look="ac-msg__tip">
        <button type="button">23:40</button>
      </Tip>,
    );
    const time = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      time.focus();
    });
    expect(tip()?.textContent).toBe("sábado, 7 de novembro de 2026 às 23:40");
    await pressEscape();
    expect(tip()).toBeNull();
    // The focus never moved: it opens again from its element, after it is left.
    expect(document.activeElement).toBe(time);
    await act(async () => {
      time.blur();
      time.focus();
    });
    expect(tip()).not.toBeNull();
    unmount();
  });

  test("one held open stays closed until `open` changes", async () => {
    const view = (open: boolean) => (
      <Tip tip="Detalhes" look="ac-msg__tip" open={open}>
        <span>23:40</span>
      </Tip>
    );
    const { rerender, unmount } = render(view(true));
    expect(tip()).not.toBeNull();
    await pressEscape();
    expect(tip()).toBeNull();
    rerender(view(true));
    expect(tip()).toBeNull();
    rerender(view(false));
    rerender(view(true));
    expect(tip()).not.toBeNull();
    unmount();
  });
});
