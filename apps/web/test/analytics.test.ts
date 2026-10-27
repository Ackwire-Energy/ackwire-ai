import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { isEuropeanTimeZone } from "@agenteschat/ui";
import { loadAnalytics } from "../src/lib/analytics";

const onDevice = (timeZone: string) =>
  spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone,
  } as Intl.ResolvedDateTimeFormatOptions);

describe("the landing's analytics", () => {
  beforeEach(() => domWindow().happyDOM.setURL("https://agentes.chat/"));
  afterEach(() => {
    document.getElementById("himetrica")?.remove();
    domWindow().happyDOM.setURL("http://localhost:3000/");
  });

  test("never load on a device set to a European time zone", () => {
    for (const zone of ["Europe/Berlin", "Atlantic/Canary"]) {
      const device = onDevice(zone);
      loadAnalytics();
      device.mockRestore();
      expect(document.getElementById("himetrica")).toBeNull();
    }
  });

  test("load elsewhere on agentes.chat", () => {
    const device = onDevice("America/Sao_Paulo");
    loadAnalytics();
    device.mockRestore();
    expect(document.getElementById("himetrica")?.getAttribute("src")).toBe("https://cdn.himetrica.com/tracker.js");
  });

  test("Europe is the EU, the EEA and the UK, wherever their zones are filed", () => {
    for (const zone of ["Europe/London", "Europe/Oslo", "Asia/Nicosia", "Indian/Reunion", "America/Cayenne"]) {
      expect(isEuropeanTimeZone(zone)).toBe(true);
    }
    for (const zone of ["America/Sao_Paulo", "Atlantic/Bermuda", "Africa/Lagos", "UTC"]) {
      expect(isEuropeanTimeZone(zone)).toBe(false);
    }
  });
});
