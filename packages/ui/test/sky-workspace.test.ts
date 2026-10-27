import { describe, expect, test } from "bun:test";
import {
  CLOUDS,
  cloudAt,
  cloudOrigin,
  HEADER_AREA,
  headerField,
  isDarkSurface,
  PHONE_AREA,
  phoneField,
  skyHourOf,
  starAt,
  workspaceInk,
  workspaceTones,
} from "../src/sky/workspace";

describe("which sky a server gets", () => {
  test("agentes.chat and its subdomains are the Cloud's day", () => {
    for (const host of ["agentes.chat", "app.agentes.chat", "AGENTES.CHAT", "agentes.chat:443"])
      expect(skyHourOf(host)).toBe("day");
  });
  test("any other host is one's own: dusk", () => {
    for (const host of ["macbook.tail1234.ts.net", "chat.acme.com", "localhost:5173", "notagentes.chat", ""])
      expect(skyHourOf(host)).toBe("dusk");
  });
});

describe("tones", () => {
  test("from the surface into the hour's light, four in all", () => {
    for (const hour of ["day", "dusk"] as const)
      for (const surface of ["#f6f9fd", "#0d1015"]) {
        const tones = workspaceTones(hour, surface);
        expect(tones).toHaveLength(4);
        expect(tones[0]).toBe(surface);
      }
    expect(workspaceTones("day", "#f6f9fd")).not.toEqual(workspaceTones("dusk", "#f6f9fd"));
  });
  test("a dark surface gets deeper tones and dimmer clouds", () => {
    expect(isDarkSurface("#0d1015")).toBe(true);
    expect(isDarkSurface("#f6f9fd")).toBe(false);
    expect(workspaceInk("day", "#f6f9fd").bright).toBe("#ffffff");
    expect(workspaceInk("day", "#0d1015").bright).not.toBe("#ffffff");
  });
});

describe("fields", () => {
  test("the header's sky: nothing behind the name, most by the chevron, gone at its foot", () => {
    for (const v of [0.1, 0.5]) expect(headerField(0.2, v, 0)).toBeLessThan(0.06);
    expect(headerField(0.95, 0.3, 0)).toBeGreaterThan(0.7);
    expect(headerField(0.95, 1, 0)).toBeLessThan(0.06);
  });
  test("the phone's sky: fullest on top, gone toward the list", () => {
    expect(phoneField(0.5, 0.05, 0)).toBeGreaterThan(0.6);
    expect(phoneField(0.5, 1, 0)).toBeLessThan(0.06);
  });
});

describe("clouds and stars", () => {
  const w = 68;
  const h = 26;
  test("nothing over the name, in either", () => {
    for (let t = 0; t < 40; t += 0.5)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < Math.floor(w * HEADER_AREA.x0); x++) {
          expect(cloudAt(x, y, w, h, t, HEADER_AREA)).toBe(0);
          expect(starAt(x, y, w, h, t, HEADER_AREA)).toBe(0);
        }
  });
  test("a cloud is drawn where its origin says, lit on top", () => {
    const t = 3;
    const [cx, cy] = cloudOrigin(0, w, h, t, HEADER_AREA);
    const first = CLOUDS[0];
    if (!first) throw new Error("no clouds");
    const [a] = first.rows[2] ?? [0];
    if (cx + a >= w * HEADER_AREA.x0 && cx + a < w) {
      expect(cloudAt(cx + a, cy + 2, w, h, t, HEADER_AREA)).toBe(1);
      expect(cloudAt(cx + 2, cy, w, h, t, HEADER_AREA)).toBe(cx + 2 >= w * HEADER_AREA.x0 ? 2 : 0);
    }
  });
  test("clouds drift left and come back from the right", () => {
    const [x0] = cloudOrigin(1, w, h, 10, HEADER_AREA);
    const [x1] = cloudOrigin(1, w, h, 11, HEADER_AREA);
    expect(x1 === x0 - 1 || x1 === x0 - 2 || x1 > x0).toBe(true);
  });
  test("on the phone, clouds stay above the title (the area's top band)", () => {
    const ph = 50;
    for (const t of [0, 7.3, 120])
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < w; x++)
          if (cloudAt(x, y, w, ph, t, PHONE_AREA)) expect(y).toBeLessThan(ph * PHONE_AREA.y1 + 4);
  });
  test("a few stars in the area, none outside it", () => {
    let stars = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = starAt(x, y, w, h, 1, HEADER_AREA);
        if (s && (y < h * HEADER_AREA.y0 || y > h * HEADER_AREA.y1)) throw new Error(`star outside at ${x},${y}`);
        if (s) stars++;
      }
    expect(stars).toBeGreaterThan(0);
    expect(stars).toBeLessThan(40);
  });
});
