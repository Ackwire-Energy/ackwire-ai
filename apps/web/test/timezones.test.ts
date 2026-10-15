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

describe("time zone groups", () => {
  test("regions: América, Europa, Ásia, África, Oceania, Antártida; oceans join a continent; sorted by offset then name", () => {
    const zones = [
      "Pacific/Auckland",
      "Australia/Sydney",
      "Atlantic/Azores",
      "Indian/Maldives",
      "Arctic/Longyearbyen",
      "Europe/London",
      "Europe/Lisbon",
      "America/Sao_Paulo",
      "Africa/Luanda",
      "Antarctica/Troll",
    ];
    const { rest } = zoneOptions([], zoneDisplayName, at, zones);
    expect(rest.map((o) => [o.region, o.zone])).toEqual([
      ["America", "America/Sao_Paulo"],
      ["Europe", "Atlantic/Azores"],
      ["Europe", "Europe/Lisbon"],
      ["Europe", "Europe/London"],
      ["Europe", "Arctic/Longyearbyen"],
      ["Asia", "Indian/Maldives"],
      ["Africa", "Africa/Luanda"],
      ["Oceania", "Australia/Sydney"],
      ["Oceania", "Pacific/Auckland"],
      ["Antarctica", "Antarctica/Troll"],
    ]);
  });
  test("pt-BR and English names", () => {
    expect(zoneDisplayName("America/Sao_Paulo", "pt-BR")).toBe("Horário de Brasília");
    expect(zoneDisplayName("America/Sao_Paulo", "en")).toBe("Brasília time");
  });
});
