import { describe, expect, test } from "bun:test";
import { filterZones, offsetLabel, parseOffsetQuery, zoneOption, zoneOptions } from "@agenteschat/ui";
import { zoneDisplayName } from "@/lib/routines";

const at = new Date("2026-10-15T12:00:00Z");
const ZONES = ["UTC", "America/Sao_Paulo", "America/New_York", "Europe/Lisbon", "Asia/Kolkata", "Asia/Tokyo"];

describe("time zones", () => {
  test("live offsets and friendly names", () => {
    expect(zoneOption("America/Sao_Paulo", zoneDisplayName, at)).toMatchObject({
      name: "Horário de Brasília",
      offset: -180,
      offsetLabel: "UTC−3",
      region: "America",
    });
    expect(zoneOption("Asia/Kolkata", zoneDisplayName, at).offsetLabel).toBe("UTC+5:30");
    expect(zoneOption("UTC", zoneDisplayName, at).offsetLabel).toBe("UTC");
    expect(zoneOption("Asia/Tokyo", undefined, at).name).toBe("Tokyo");
    expect(offsetLabel(-210)).toBe("UTC−3:30");
  });

  test("suggested first (no duplicates), the rest by region", () => {
    const { suggested, rest } = zoneOptions(["Europe/Lisbon", "UTC", "Europe/Lisbon"], zoneDisplayName, at, ZONES);
    expect(suggested.map((o) => o.zone)).toEqual(["Europe/Lisbon", "UTC"]);
    expect(rest.map((o) => o.region)).toEqual(["America", "America", "Asia", "Asia"]);
    expect(rest.map((o) => o.zone)).not.toContain("Europe/Lisbon");
  });

  test("search by city, country words, IANA id or offset", () => {
    const list = ZONES.map((z) => zoneOption(z, zoneDisplayName, at));
    const zones = (q: string) => filterZones(list, q).map((o) => o.zone);
    expect(zones("lisboa")).toEqual(["Europe/Lisbon"]);
    expect(zones("brasilia")).toEqual(["America/Sao_Paulo"]);
    expect(zones("sao paulo")).toEqual(["America/Sao_Paulo"]);
    expect(zones("new york")).toEqual(["America/New_York"]);
    expect(zones("-3")).toEqual(["America/Sao_Paulo"]);
    expect(zones("gmt-3")).toEqual(["America/Sao_Paulo"]);
    expect(zones("UTC+5:30")).toEqual(["Asia/Kolkata"]);
    expect(parseOffsetQuery("tokyo")).toBeNull();
  });
});
