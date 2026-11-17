import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer, type ComposerSuggestion } from "../src/components/Composer";
import { composes, trackInput } from "../src/device";

afterEach(() => cleanup());

const PEOPLE: ComposerSuggestion[] = [
  { key: "helga", insert: "helga", label: "Helga" },
  { key: "helena", insert: "helena", label: "Helena" },
];

/** The Enter that confirms a word, as each engine sends it: Chrome inside the composition, Safari right after it. */
const CONFIRMS = [
  { name: "inside the composition", init: { key: "Enter", isComposing: true, keyCode: 229 } },
  { name: "right after it ended", init: { key: "Enter", keyCode: 229 } },
] as const;

function Box({ sent }: { sent: string[] }) {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={(text) => {
        sent.push(text);
        setValue("");
      }}
      label="Mensagem"
      sendLabel="Enviar"
      mentions={{ search: (q) => PEOPLE.filter((p) => p.insert.startsWith(q)), listLabel: "Pessoas e agentes" }}
    />
  );
}

function setup() {
  const sent: string[] = [];
  render(<Box sent={sent} />);
  const box = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
  const type = (value: string) =>
    act(async () => {
      fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
    });
  const press = (init: KeyboardEventInit) =>
    act(async () => {
      fireEvent.keyDown(box, init);
    });
  return { box, sent, type, press };
}

test("composes: an input method's key, also the one Safari sends after the composition ended", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  for (const { init } of CONFIRMS) expect(composes(key(init))).toBe(true);
  expect(composes(key({ key: "Enter" }))).toBe(false);
});

for (const { name, init } of CONFIRMS) {
  test(`the Enter that confirms a word (${name}) leaves the draft in the box; the next Enter sends it`, async () => {
    const { box, sent, type, press } = setup();
    await type("こんにちは");
    await press(init);
    expect(sent).toEqual([]);
    expect(box.value).toBe("こんにちは");
    await press({ key: "Enter" });
    expect(sent).toEqual(["こんにちは"]);
  });

  test(`with the @ list open, the input method's keys (${name}) pick and move nothing in it`, async () => {
    const { box, sent, type, press } = setup();
    await type("oi @hel");
    const first = () => screen.getAllByRole("option")[0]?.getAttribute("aria-selected");
    expect(first()).toBe("true");
    await press({ ...init, key: "ArrowDown" });
    expect(first()).toBe("true");
    await press(init);
    expect(box.value).toBe("oi @hel");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(sent).toEqual([]);
  });

  test(`a field's own Enter never hears the one that confirms a word (${name})`, async () => {
    trackInput();
    const heard: string[] = [];
    render(<input aria-label="Nome" onKeyDown={(e) => heard.push(e.key)} />);
    const field = screen.getByLabelText("Nome");
    fireEvent.keyDown(field, init);
    expect(heard).toEqual([]);
    // Every other key the input method takes stays the field's to read or ignore.
    fireEvent.keyDown(field, { ...init, key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(heard).toEqual(["ArrowDown", "Enter"]);
  });
}
