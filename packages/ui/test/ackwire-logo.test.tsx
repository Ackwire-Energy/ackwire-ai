import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { PIXEL_MARK_VIEWBOX, pixelMarkRuns } from "../src/brand/ackwire";
import { Logo, LogoMark } from "../src/components/Logo";

afterEach(cleanup);

test("a workspace accent changes the Ackwire mark's color without changing its pixel A", () => {
  const r = render(<LogoMark label="Workspace" />);
  const mark = r.getByRole("img", { name: "Workspace" });
  const shape = () =>
    [...mark.querySelectorAll("rect")].map((rect) =>
      ["x", "y", "width", "height"].map((name) => Number(rect.getAttribute(name))),
    );
  const expected = pixelMarkRuns().map(({ x, y, w }) => [x, y, w, 1]);
  expect(mark.getAttribute("viewBox")).toBe(PIXEL_MARK_VIEWBOX);
  expect(shape()).toEqual(expected);
  expect(mark.style.getPropertyValue("--logo-accent")).toBe("");
  r.rerender(<LogoMark label="Workspace" sky={["#c4b5fd", "#7c3aed"]} />);
  expect(mark.style.getPropertyValue("--logo-accent")).toBe("#7c3aed");
  expect(shape()).toEqual(expected);
  expect(mark.querySelector("image, path")).toBeNull();
});

test("both logo lockups retain the Ackwire AI name and monochrome variant", () => {
  const r = render(<Logo variant="expanded" mono />);
  const logo = r.getByRole("img", { name: "Ackwire AI" });
  expect(logo.classList.contains("ac-logo--mono")).toBe(true);
  expect(logo.textContent).toBe("AckwireAI");
  expect(logo.querySelector("svg")?.getAttribute("viewBox")).toBe(PIXEL_MARK_VIEWBOX);
});
