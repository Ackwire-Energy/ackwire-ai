import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { Avatar, ditherCells, ditherSvg, ditherTones, ditherUrl, Logo } from "../src";
import { liveAgentCount } from "../src/agent/live";

describe("agent dither", () => {
  test("covers the whole grid, light on top and deep at the bottom", () => {
    const svg = ditherSvg("violet", 8);
    const tones = ditherTones("violet");
    const rows = new Map<number, { width: number; fill: string }[]>();
    for (const m of svg.matchAll(/<rect x="\d+" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"\/>/g)) {
      const y = Number(m[1]);
      rows.set(y, [...(rows.get(y) ?? []), { width: Number(m[2]), fill: m[3] ?? "" }]);
    }
    expect(rows.size).toBe(8);
    for (const runs of rows.values()) expect(runs.reduce((s, r) => s + r.width, 0)).toBe(8);
    const level = (y: number) => {
      const runs = rows.get(y) ?? [];
      return runs.reduce((s, r) => s + tones.indexOf(r.fill) * r.width, 0) / 8;
    };
    expect(level(0)).toBeGreaterThan(level(7));
  });

  test("the grid follows the size and the data URL is cached", () => {
    expect(ditherCells(18)).toBeLessThan(ditherCells(112));
    expect(ditherUrl("sky", 10)).toBe(ditherUrl("sky", 10));
    expect(ditherUrl("sky", 10).startsWith("data:image/svg+xml,")).toBe(true);
  });

  test("agents are drawn by the engine; people are not; the logo carries the dither", () => {
    const before = liveAgentCount();
    const { container } = render(
      <>
        <Avatar kind="agent" name="Bia" appearance={{ color: "rose" }} />
        <Avatar name="Ana Lima" />
        <Logo />
        <Logo mono />
      </>,
    );
    const [agent, person] = [...container.querySelectorAll<HTMLElement>(".ac-avatar")];
    // Agents are drawn by the engine on a canvas, registered in the live loop; people are not.
    expect(liveAgentCount()).toBe(before + 1);
    expect(agent?.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(person?.querySelector("canvas")).toBeNull();
    expect(container.querySelectorAll(".ac-logo__dither")).toHaveLength(2);
  });
});
