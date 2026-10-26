import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { CardHeader, Dialog, DialogBody, Field, hoverPointer, InfoHint, Input } from "../src";

afterEach(cleanup);

const TEXT = "Rotinas, lembretes e o calendário seguem este fuso.";
const body = () => within(document.body);
const tip = () => body().queryByRole("tooltip");
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/** A mouse press as a browser sends it: the pointer goes down (focusing the button), then the click. */
async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(el, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(el);
    el.focus();
    fireEvent.pointerUp(el, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(el);
    fireEvent.click(el);
  });
  await wait(0);
}

/** Tab from wherever focus is to `next`, as the keyboard moves it (`altKey`: ⌥Tab). */
async function tabTo(next: HTMLElement, held: { altKey?: boolean } = {}) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", ...held });
    next.focus();
  });
  await wait(0);
}

function Hint() {
  return (
    <>
      <span className="ac-hintline">
        <span>Fuso horário</span>
        <InfoHint name="Sobre Fuso horário">{TEXT}</InfoHint>
      </span>
      <button type="button">Depois</button>
    </>
  );
}

const hintButton = () => body().getByRole("button", { name: "Sobre Fuso horário" });

describe("InfoHint", () => {
  test("the ⓘ is a button named for its label, described by the hint's text even while closed", () => {
    render(<Hint />);
    const button = hintButton();
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(TEXT);
    expect(described?.hidden).toBe(true);
    // A hint, not a dialog: nothing announces a popup.
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    expect(tip()).toBeNull();
  });

  test("a click opens the bubble in a portal, a second click closes it; Escape closes it too", async () => {
    const { container } = render(<Hint />);
    await press(hintButton());
    const bubble = tip();
    expect(bubble?.textContent).toBe(TEXT);
    expect(container.contains(bubble)).toBe(false);
    // Focus stays on the ⓘ.
    expect(document.activeElement).toBe(hintButton());
    await press(hintButton());
    expect(tip()).toBeNull();
    await press(hintButton());
    expect(tip()).not.toBeNull();
    await act(async () => fireEvent.keyDown(hintButton(), { key: "Escape" }));
    expect(tip()).toBeNull();
  });

  test("a mouse resting on it opens it after the delay; a touch never does", async () => {
    // A mouse or a pen rests over things; a finger, or a pointer that doesn't say, only presses.
    expect(["mouse", "pen", "touch", ""].map(hoverPointer)).toEqual([true, true, false, false]);
    render(<Hint />);
    await act(async () => fireEvent.pointerEnter(hintButton(), { pointerType: "touch" }));
    await wait(320);
    expect(tip()).toBeNull();
    await act(async () => fireEvent.pointerLeave(hintButton(), { pointerType: "touch" }));
    await act(async () => fireEvent.pointerEnter(hintButton(), { pointerType: "mouse" }));
    await wait(100);
    expect(tip()).toBeNull();
    await wait(220);
    expect(tip()?.textContent).toBe(TEXT);
    // Leaving closes it, a moment later.
    await act(async () => fireEvent.pointerLeave(hintButton(), { pointerType: "mouse" }));
    await wait(220);
    expect(tip()).toBeNull();
  });

  test("the pointer may cross onto the bubble: it stays open while over it and closes once it leaves", async () => {
    render(<Hint />);
    await act(async () => fireEvent.pointerEnter(hintButton(), { pointerType: "mouse" }));
    await wait(320);
    const bubble = tip();
    expect(bubble).not.toBeNull();
    await act(async () => fireEvent.pointerLeave(hintButton(), { pointerType: "mouse" }));
    await wait(60);
    await act(async () => fireEvent.pointerEnter(bubble as HTMLElement, { pointerType: "mouse" }));
    await wait(400);
    expect(tip()?.textContent).toBe(TEXT);
    await act(async () => fireEvent.pointerLeave(bubble as HTMLElement, { pointerType: "mouse" }));
    await wait(220);
    expect(tip()).toBeNull();
  });

  test("a hint keyboard focus opened under a resting mouse stays closed once focus moves on", async () => {
    render(<Hint />);
    await tabTo(hintButton());
    const bubble = tip();
    expect(bubble).not.toBeNull();
    // The bubble opens under the mouse, which never moves.
    await act(async () => fireEvent.pointerEnter(bubble as HTMLElement, { pointerType: "mouse" }));
    // Tab on: a browser commits the blur's update before the next element takes focus.
    await act(async () => {
      fireEvent.keyDown(hintButton(), { key: "Tab" });
      hintButton().blur();
    });
    await act(async () => body().getByRole("button", { name: "Depois" }).focus());
    expect(tip()).toBeNull();
    await wait(320);
    expect(tip()).toBeNull();
  });

  test("a click on a hint that hover opened pins it: it stays open when the pointer leaves", async () => {
    render(<Hint />);
    await act(async () => fireEvent.pointerEnter(hintButton(), { pointerType: "mouse" }));
    await wait(320);
    expect(tip()).not.toBeNull();
    await press(hintButton());
    expect(tip()).not.toBeNull();
    await act(async () => fireEvent.pointerLeave(hintButton(), { pointerType: "mouse" }));
    await wait(220);
    expect(tip()?.textContent).toBe(TEXT);
    // A press anywhere else closes it.
    await press(body().getByRole("button", { name: "Depois" }));
    expect(tip()).toBeNull();
  });

  test("keyboard focus opens it at once without moving focus; moving on closes it; a press's focus opens nothing", async () => {
    render(<Hint />);
    await tabTo(hintButton());
    expect(tip()?.textContent).toBe(TEXT);
    expect(document.activeElement).toBe(hintButton());
    await tabTo(body().getByRole("button", { name: "Depois" }));
    expect(tip()).toBeNull();
    // The pointer goes down on the ⓘ and focuses it; until the click, nothing opens.
    await act(async () => {
      fireEvent.pointerDown(hintButton(), { pointerType: "mouse", button: 0 });
      hintButton().focus();
    });
    await wait(0);
    expect(document.activeElement).toBe(hintButton());
    expect(tip()).toBeNull();
  });

  test("⌥Tab, the way Safari reaches a button, opens it like Tab; the focus a shortcut brings opens nothing", async () => {
    render(<Hint />);
    const after = body().getByRole("button", { name: "Depois" });
    await press(after);
    await tabTo(hintButton(), { altKey: true });
    expect(tip()?.textContent).toBe(TEXT);
    await press(after);
    expect(tip()).toBeNull();
    await act(async () => {
      fireEvent.keyDown(after, { key: "k", metaKey: true });
      hintButton().focus();
    });
    await wait(0);
    expect(tip()).toBeNull();
  });

  test("inside a dialog, Escape closes the hint and leaves the dialog open", async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Novo agente" closeLabel="Fechar">
        <DialogBody>
          <InfoHint name="Sobre Orçamento">No limite, o agente para e avisa.</InfoHint>
        </DialogBody>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Novo agente" });
    await press(within(dialog).getByRole("button", { name: "Sobre Orçamento" }));
    const bubble = tip();
    expect(bubble?.textContent).toBe("No limite, o agente para e avisa.");
    // Above the dialog, outside it.
    expect(dialog.contains(bubble)).toBe(false);
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(tip()).toBeNull();
    expect(body().getByRole("dialog", { name: "Novo agente" })).toBeTruthy();
  });

  test("the bubble floats above dialogs: its layer is above the dialog's", async () => {
    const css = (file: string) => Bun.file(new URL(`../src/styles/${file}`, import.meta.url).pathname).text();
    const [components, layers] = await Promise.all([css("components.css"), css("layers.css")]);
    const layer = (selector: string) => {
      const name = components
        .split(`${selector} {`)[1]
        ?.split("}")[0]
        ?.match(/z-index: var\(--z-([\w-]+)\)/)?.[1];
      return Number(layers.match(new RegExp(`--z-${name}:\\s*(\\d+)`))?.[1]);
    };
    expect(layer(".ac-hint__bubble")).toBeGreaterThan(layer(".ac-dialog"));
  });

  test("the keyboard focus ring stays clear of the label: inside the target, past the part that reaches into it", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
    const px = (text: string, prop: string) =>
      Number(text.match(new RegExp(`(?:^|\\s)${prop}:\\s*(-?[\\d.]+)px`))?.[1]);
    // The 24px target overhangs the glyph's box by its negative margin, and the line's gap takes back part of it.
    const intoLabel = -px(rule(".ac-hint"), "margin") - px(rule(".ac-hintline"), "gap");
    const ring = rule(".ac-hint:focus-visible");
    expect(ring).not.toContain("box-shadow");
    // An outline drawn inward: its outer edge sits this far inside the target's.
    const inside = -(px(ring, "outline-offset") + px(ring, "outline"));
    expect(intoLabel).toBeGreaterThan(0);
    expect(inside).toBeGreaterThan(intoLabel);
  });
});

describe("hints on fields and cards", () => {
  test("a field's hint describes its control, and its ⓘ stays outside the label", () => {
    render(
      <Field
        label="Fuso horário"
        id="tz"
        help="Muda para todo o workspace."
        hint={{ name: "Sobre Fuso horário", text: TEXT }}
      >
        <Input />
      </Field>,
    );
    const input = body().getByRole("textbox", { name: "Fuso horário" });
    expect(input.getAttribute("aria-describedby")).toBe("tz-help tz-hint");
    expect(document.getElementById("tz-hint")?.textContent).toBe(TEXT);
    const label = document.querySelector("label[for='tz']");
    expect(label?.textContent).toBe("Fuso horário");
    expect(label?.contains(hintButton())).toBe(false);
    expect(
      hintButton()
        .closest(".ac-hintline")
        ?.contains(label ?? null),
    ).toBe(true);
  });

  test("a card's hint sits beside its heading, never in it", () => {
    render(<CardHeader title="Seu plano do Claude" hint={{ name: "Sobre Seu plano do Claude", text: TEXT }} />);
    const heading = body().getByRole("heading", { name: "Seu plano do Claude" });
    expect(heading.textContent).toBe("Seu plano do Claude");
    const button = body().getByRole("button", { name: "Sobre Seu plano do Claude" });
    expect(heading.contains(button)).toBe(false);
    expect(heading.parentElement?.contains(button)).toBe(true);
  });
});
