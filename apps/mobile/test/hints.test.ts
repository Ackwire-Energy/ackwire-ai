import { beforeEach, describe, expect, test } from "bun:test";
import { hintBack, hintClosed, hintOpened, hintTouched, hintTouches } from "../src/ui/hints";

const at = (x: number, y: number) => ({ nativeEvent: { pageX: x, pageY: y } });

/** A hint as `InfoHint` registers it: `open` mirrors its state. */
function hint(id: string) {
  const h = {
    id,
    open: false,
    show() {
      h.open = true;
      hintOpened({ id, close: () => (h.open = false) });
    },
  };
  return h;
}

/** A tap that starts and ends at one point; `on` is the hint whose ⓘ or text it lands on. */
function tap(on?: string, from = at(10, 10), to = from) {
  hintTouches.onTouchStartCapture(from);
  if (on) hintTouched(on);
  hintTouches.onTouchEnd(to);
}

describe("an ⓘ hint on the phone", () => {
  beforeEach(() => {
    // Whatever a test left open closes, so each starts with none.
    hintBack();
  });

  test("a tap anywhere else closes it; a tap on its own ⓘ or text leaves it to the ⓘ", () => {
    const a = hint("a");
    a.show();
    tap("a");
    expect(a.open).toBe(true);
    tap();
    expect(a.open).toBe(false);
  });

  test("a scroll leaves it open, so a long text can be read; so does a touch the system took over", () => {
    const a = hint("a");
    a.show();
    tap(undefined, at(10, 10), at(10, 60));
    expect(a.open).toBe(true);
    hintTouches.onTouchStartCapture(at(10, 10));
    hintTouches.onTouchCancel();
    hintTouches.onTouchEnd(at(10, 10));
    expect(a.open).toBe(true);
  });

  test("one at a time: opening another closes the first, whichever handler runs first", () => {
    const a = hint("a");
    const b = hint("b");
    a.show();
    // The tap on b's ⓘ ends outside a: a closes, and b's own press opens b.
    tap("b");
    b.show();
    expect([a.open, b.open]).toEqual([false, true]);
    // The press may also run before the end of the touch reaches the app's view.
    hintTouches.onTouchStartCapture(at(10, 10));
    hintTouched("a");
    a.show();
    hintTouches.onTouchEnd(at(10, 10));
    expect([a.open, b.open]).toEqual([true, false]);
  });

  test("a touch starts with no owner: one that began on an ⓘ doesn't make the next one its own", () => {
    const a = hint("a");
    a.show();
    hintTouches.onTouchStartCapture(at(10, 10));
    hintTouched("a");
    hintTouches.onTouchCancel();
    tap();
    expect(a.open).toBe(false);
  });

  test("Android's back closes it, and only when one is open does it keep the screen", () => {
    const a = hint("a");
    a.show();
    expect(hintBack()).toBe(true);
    expect(a.open).toBe(false);
    expect(hintBack()).toBe(false);
  });

  test("closed by its own ⓘ, or gone from the screen, it is forgotten: back leaves the screen again", () => {
    const a = hint("a");
    a.show();
    hintClosed("a");
    expect(hintBack()).toBe(false);
  });
});
