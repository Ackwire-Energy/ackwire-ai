import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { ImageZoom } from "@/components/artifacts/ImageZoom";
import { createI18n } from "@/i18n";

const STAGE = { w: 1200, h: 700 };
const realRect = HTMLElement.prototype.getBoundingClientRect;
let realMatch: typeof matchMedia;
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // Mid open animation (the dialog scales in from 0.97): the fit must come from the layout size, not this one.
    const [w, h] = [STAGE.w * 0.97, STAGE.h * 0.97];
    const r = { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
    return { ...r, toJSON: () => r } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => STAGE.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => STAGE.h });
  realMatch = window.matchMedia;
  // A mouse (the hover lens is offered), or a finger when `touch` is set.
  window.matchMedia = ((query: string) => ({
    matches: !touch && query.includes("hover: hover"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof matchMedia;
});
let touch = false;
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  if (typeof window !== "undefined") window.matchMedia = realMatch;
});
afterEach(() => {
  cleanup();
  touch = false;
  try {
    localStorage.clear();
  } catch {}
});

/** A 3600×600 banner (fits at a third of its size, centered 250 px down) in a 1200×700 stage. */
const show = async (w = 3600, h = 600) => {
  const r = render(
    <I18nextProvider i18n={createI18n("pt-BR")}>
      <ImageZoom src="blob:picture" alt="Imagem: banner.png" />
    </I18nextProvider>,
  );
  const img = r.container.querySelector<HTMLImageElement>(".izoom__img");
  if (!img) throw new Error("no picture");
  Object.defineProperty(img, "naturalWidth", { value: w });
  Object.defineProperty(img, "naturalHeight", { value: h });
  await act(async () => fireEvent.load(img));
  const stage = r.getByRole("group", { name: "Imagem: banner.png" });
  const bar = within(r.getByRole("toolbar", { name: "Zoom" }));
  return { ...r, img, stage, bar };
};
const scaleOf = (img: HTMLImageElement) => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)?.[1]);
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};

describe("the picture viewer's zoom", () => {
  test("fitted to the stage, centered, with − and Ajustar off until zoomed", async () => {
    const { img, bar } = await show();
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    expect(img.style.transform).toContain("translate(0px, 250px)");
    expect(bar.getByRole("button", { name: "Reduzir" }).hasAttribute("disabled")).toBe(true);
    expect(bar.getByRole("button", { name: "Ajustar" }).hasAttribute("disabled")).toBe(true);
    expect(bar.getByText("33%")).toBeTruthy();
  });

  test("a click zooms to the real size at the pointer, a second one fits it back", async () => {
    const { img, stage, getByText } = await show();
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
    });
    expect(scaleOf(img)).toBe(1);
    // The banner's middle stays under the pointer.
    expect(img.style.transform).toContain("translate(-1200px, 50px)");
    expect(getByText("Arraste para mover. Esc volta a ajustar")).toBeTruthy();
    // The second click of a double-click keeps the zoom.
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
    });
    expect(scaleOf(img)).toBe(1);
    await Bun.sleep(450);
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    });
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
  });

  test("a drag moves the zoomed picture, never past its edge", async () => {
    const { img, stage, bar } = await show();
    await act(async () => fireEvent.click(bar.getByRole("button", { name: "Tamanho real" })));
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 5600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 5600, clientY: 350 });
    });
    expect(scaleOf(img)).toBe(1);
    expect(img.style.transform).toContain("translate(0px, 50px)");
  });

  test("keys: + and − step, 1 is the real size, Esc fits first and only then lets the dialog close", async () => {
    const { img, stage } = await show();
    key(stage, "+");
    expect(scaleOf(img)).toBe(0.5);
    key(stage, "1");
    expect(scaleOf(img)).toBe(1);
    key(stage, "-");
    expect(scaleOf(img)).toBe(0.75);
    expect(key(stage, "Escape").defaultPrevented).toBe(true);
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    expect(key(stage, "Escape").defaultPrevented).toBe(false);
  });

  test("a mouse wheel and a trackpad pinch zoom around the cursor; two fingers move only a zoomed picture", async () => {
    const { img, stage } = await show();
    const wheel = (init: WheelEventInit) => {
      const e = new WheelEvent("wheel", { cancelable: true, ...init });
      // happy-dom's WheelEvent leaves out the mouse position and the modifier keys.
      Object.defineProperties(e, {
        clientX: { value: 0 },
        clientY: { value: 350 },
        ctrlKey: { value: Boolean(init.ctrlKey) },
      });
      act(() => {
        stage.dispatchEvent(e);
      });
      return e;
    };
    // A two-finger scroll on the fitted picture does nothing and leaves the event to the page.
    expect(wheel({ deltaY: 12.5, deltaX: 3 }).defaultPrevented).toBe(false);
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    wheel({ deltaY: -400 });
    expect(scaleOf(img)).toBeGreaterThan(0.6);
    expect(img.style.transform).toContain("translate(0px,");
    const zoomed = scaleOf(img);
    wheel({ deltaY: -20, ctrlKey: true });
    expect(scaleOf(img)).toBeGreaterThan(zoomed);
    const before = img.style.transform;
    expect(wheel({ deltaY: 0, deltaX: 40.5 }).defaultPrevented).toBe(true);
    expect(img.style.transform).not.toBe(before);
    expect(img.style.transform).toContain("translate(-40.5px,");
  });

  test("on a touch screen the hints say tap and pinch", async () => {
    touch = true;
    const { stage, getByText } = await show();
    expect(getByText("Toque ou faça pinça para ampliar")).toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
    });
    expect(getByText("Arraste para mover. Toque para voltar a ajustar")).toBeTruthy();
  });

  test("the hover lens shows a magnified pane, and can be switched off", async () => {
    const { container, stage, bar } = await show(800, 2800);
    await act(async () =>
      fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "mouse", clientX: 600, clientY: 300 }),
    );
    expect(container.querySelector(".izoom__lens")).toBeTruthy();
    expect(container.querySelector(".izoom__pane img")).toBeTruthy();
    const lens = bar.getByRole("button", { name: "Lupa" });
    expect(lens.getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(lens));
    expect(lens.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".izoom__lens")).toBeNull();
    expect(localStorage.getItem("agentes.image.lens")).toBe("0");
  });

  test("a picture the browser can't draw says so instead of an empty stage", async () => {
    const r = render(
      <I18nextProvider i18n={createI18n("pt-BR")}>
        <ImageZoom src="blob:broken" alt="Imagem: x.png" />
      </I18nextProvider>,
    );
    expect(r.getByRole("status").textContent).toContain("Carregando");
    const img = r.container.querySelector<HTMLImageElement>(".izoom__img");
    if (!img) throw new Error("no picture");
    await act(async () => fireEvent.error(img));
    expect(r.getByRole("status").textContent).toContain("Não deu para mostrar a prévia");
  });
});
