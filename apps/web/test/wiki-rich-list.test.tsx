import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { WikiRichEditor } from "@/components/wiki/WikiRichEditor";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, screen } from "./render";

afterEach(() => cleanup());

test("the editor's block list (/) takes the room on its side of the caret, not a fixed height that scrolls with room left", async () => {
  await renderPage(<WikiRichEditor value="" onChange={() => {}} onSave={() => {}} pages={[]} label="Texto" />, {
    api: createFakeApi(seedState()),
  });
  const box = screen().getByRole("textbox", { name: "Texto" });
  const p = box.querySelector("p") ?? box.appendChild(document.createElement("p"));
  p.textContent = "/";
  const text = p.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, text.length);
  range.collapse(true);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  await act(async () => fireEvent.input(box));
  const list = screen().getByRole("listbox");
  // happy-dom has no layout: the caret is at 0, so the whole window under it, less the gap and the edge's room.
  expect(list.style.maxHeight).toBe(`${window.innerHeight - 6 - 12}px`);
  expect(list.style.top).toBe("6px");
});
