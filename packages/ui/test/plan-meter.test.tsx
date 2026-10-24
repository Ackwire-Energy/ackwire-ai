import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { PlanMeter, type PlanMeterText, type PlanMeterUsage, planState, planWindows } from "../src";

afterEach(() => cleanup());

const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const text: PlanMeterText = {
  window: (w) => (w.kind === "five_hour" ? "5 horas" : w.kind === "seven_day" ? "Semana" : (w.label ?? "Outro")),
  resets: (iso) => `volta ${iso.slice(11, 16)}`,
  almost: "Quase no limite",
  limited: (until) => (until ? `No limite até ${until.slice(11, 16)}` : "No limite"),
  updated: (iso) => `Atualizado ${iso.slice(11, 16)}`,
};

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll(".ac-planmeter__window")].map((li) => [
    li.querySelector(".ac-planmeter__name")?.textContent,
    li.querySelector(".ac-planmeter__pct")?.textContent,
    li.querySelector(".ac-planmeter__reset")?.textContent ?? null,
  ]);

test("a bar per window, tightest first, each with its percentage and reset; how old the numbers are", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "seven_day", usedPercent: 35, resetsAt: at(48 * HOUR) },
      { kind: "five_hour", usedPercent: 62, resetsAt: at(2 * HOUR) },
      { kind: "other", label: "Fable", usedPercent: 35 },
    ],
    at: at(-5 * 60_000),
  };
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} />);
  const el = container.querySelector(".ac-planmeter") as HTMLElement;
  expect(el.dataset.state).toBe("ok");
  expect(el.querySelector(".ac-planmeter__state")).toBeNull();
  // The same share: the shorter window first.
  expect(rows(el)).toEqual([
    ["5 horas", "62%", "volta 14:00"],
    ["Semana", "35%", "volta 12:00"],
    ["Fable", "35%", null],
  ]);
  const meters = [...el.querySelectorAll("[role=meter]")];
  expect(meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
    ["5 horas", "62"],
    ["Semana", "35"],
    ["Fable", "35"],
  ]);
  expect(el.querySelector(".ac-planmeter__at")?.textContent).toBe("Atualizado 11:55");
});

test("from 80% it says so; at 100% it is at the limit until every full window resets", () => {
  const almost = render(
    <PlanMeter usage={{ windows: [{ kind: "five_hour", usedPercent: 80 }], at: at(0) }} text={text} now={NOW} />,
  ).container;
  expect(almost.querySelector(".ac-planmeter")?.getAttribute("data-state")).toBe("almost");
  expect(almost.querySelector(".ac-planmeter__state")?.textContent).toBe("Quase no limite");
  cleanup();
  const full: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 100, resetsAt: at(HOUR) },
      { kind: "seven_day", usedPercent: 100, resetsAt: at(30 * HOUR) },
    ],
    limited: true,
    at: at(0),
  };
  const limited = render(<PlanMeter usage={full} text={text} now={NOW} />).container;
  expect(limited.querySelector(".ac-planmeter__state")?.textContent).toBe("No limite até 18:00");
  expect(planState(full, NOW)).toEqual({ state: "limited", until: at(30 * HOUR), used: 100 });
  // Refused without saying which window: at the limit, until unknown.
  expect(planState({ windows: [{ kind: "five_hour", usedPercent: 40 }], limited: true, at: at(0) }, NOW)).toEqual({
    state: "limited",
    until: null,
    used: 40,
  });
});

test("a window whose reset already passed is empty again, and the limit with it", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 100, resetsAt: at(-HOUR) },
      { kind: "seven_day", usedPercent: 70, resetsAt: at(24 * HOUR) },
    ],
    limited: true,
    at: at(-2 * HOUR),
  };
  expect(planWindows(usage, NOW).map((w) => [w.kind, w.used])).toEqual([
    ["seven_day", 70],
    ["five_hour", 0],
  ]);
  expect(planState(usage, NOW).state).toBe("ok");
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} />);
  expect(rows(container)[1]).toEqual(["5 horas", "0%", null]);
});

test("compact: the tightest window only, no resets, no age", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "seven_day", usedPercent: 91, resetsAt: at(HOUR) },
      { kind: "five_hour", usedPercent: 20 },
    ],
    at: at(0),
  };
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} compact />);
  expect(rows(container)).toEqual([["Semana", "91%", null]]);
  expect(container.querySelector(".ac-planmeter__at")).toBeNull();
  expect(container.querySelector(".ac-planmeter__state")?.textContent).toBe("Quase no limite");
});

test("an agent's part: in full ink inside its window's bar, with its words; none once the window reset", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 60, resetsAt: at(HOUR), part: 45, note: "Ada ≈ 45%" },
      { kind: "seven_day", usedPercent: 50, resetsAt: at(-HOUR), part: 20, note: "Ada ≈ 20%" },
    ],
    at: at(0),
  };
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} />);
  const [hours, week] = [...container.querySelectorAll(".ac-planmeter__window")];
  expect(hours?.querySelector(".ac-meter--parts .ac-meter__part")?.getAttribute("style")).toContain("width: 45%");
  expect(hours?.querySelector(".ac-planmeter__note")?.textContent).toBe("Ada ≈ 45%");
  expect(week?.querySelector(".ac-meter__part")).toBeNull();
  expect(week?.querySelector(".ac-planmeter__note")).toBeNull();
});
