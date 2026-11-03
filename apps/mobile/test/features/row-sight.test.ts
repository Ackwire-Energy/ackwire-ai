import { describe, expect, test } from "bun:test";
import { RowSight, rowsShown } from "../../src/features/chat/row-sight";

/** A drawn row's view: the screen measures it, these tests only register it. */
const view = () => ({ measureInWindow: () => {} });

describe("which agents' live rows are on screen", () => {
  test("a drawn row counts as on screen until the screen first looks, so the line never flashes", () => {
    const sight = new RowSight();
    expect(sight.getInView().size).toBe(0);
    sight.register("r1", view());
    expect([...sight.getInView()]).toEqual(["r1"]);
  });

  test("after a look, only the rows that show; a row that goes is out of view at once", () => {
    const sight = new RowSight();
    const dropR1 = sight.register("r1", view());
    sight.register("r2", view());
    sight.setShown(["r2"]);
    expect([...sight.getInView()]).toEqual(["r2"]);
    sight.setShown(["r1", "r2"]);
    dropR1();
    expect([...sight.getInView()]).toEqual(["r2"]);
    // A row not drawn (waiting its moment, or scrolled out of what the list keeps) is never on screen.
    sight.setShown(["r2", "r3"]);
    expect([...sight.getInView()]).toEqual(["r2"]);
  });

  test("the same row drawn again (its waiting row turning into its words) keeps its place without a flash", () => {
    const sight = new RowSight();
    const first = view();
    const dropFirst = sight.register("r1", first);
    sight.setShown(["r1"]);
    const second = view();
    sight.register("r1", second);
    // The old view going after the new one is drawn takes nothing back.
    dropFirst();
    expect([...sight.getInView()]).toEqual(["r1"]);
    expect(sight.drawn()).toEqual([["r1", second]]);
  });

  test("listeners hear only a change of the set, and the set keeps its identity until then", () => {
    const sight = new RowSight();
    let heard = 0;
    sight.subscribe(() => {
      heard += 1;
    });
    sight.register("r1", view());
    const before = sight.getInView();
    sight.setShown(["r1"]);
    sight.setShown(["r1"]);
    expect(heard).toBe(1);
    expect(sight.getInView()).toBe(before);
    sight.setShown([]);
    expect(heard).toBe(2);
    expect(sight.getInView().size).toBe(0);
  });

  test("a row drawn or gone asks the screen to look again", () => {
    const sight = new RowSight();
    let looks = 0;
    sight.watch(() => {
      looks += 1;
    });
    expect(sight.hasRows()).toBe(false);
    const drop = sight.register("r1", view());
    expect(sight.hasRows()).toBe(true);
    drop();
    expect(looks).toBe(2);
    expect(sight.hasRows()).toBe(false);
  });

  test("a row shows while 40 points of it do between the header and the composer (or all of a smaller one)", () => {
    const band = { top: 100, bottom: 700 };
    const rows = [
      // Mostly under the composer (or the keyboard): 20 points show.
      { runId: "under", y: 680, height: 60 },
      { runId: "end", y: 640, height: 52 },
      // Under the floating header: 12 points show.
      { runId: "top", y: 60, height: 52 },
      { runId: "tall", y: -400, height: 1200 },
      // Not laid out yet: counted as shown.
      { runId: "new", y: 300, height: 0 },
      { runId: "gone", y: 900, height: 52 },
    ];
    expect(rowsShown(rows, band)).toEqual(["end", "tall", "new"]);
  });
});
