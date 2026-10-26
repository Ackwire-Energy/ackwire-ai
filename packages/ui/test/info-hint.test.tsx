import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { CardHeader, Dialog, DialogBody, Field, InfoHint, Input } from "../src";

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

/** Tab from wherever focus is to `next`, as the keyboard moves it. */
async function tabTo(next: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
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

  test("the bubble floats above dialogs", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = css.split(".ac-hint__bubble {")[1]?.split("}")[0] ?? "";
    expect(rule).toContain("z-index: var(--z-floating)");
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
