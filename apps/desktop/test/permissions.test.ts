import { expect, test } from "bun:test";
import { allDone, askedIn, readGrants, viaSettings, withAsked } from "../src/control/permissions";
import type { Host } from "../src/host/types";

/** A Mac's answers for Screen Recording and Full Disk Access. Local Network has none. */
const mac = (screen: boolean, disk: boolean) =>
  ({ screenAccess: async () => screen, diskAccess: async () => disk }) as unknown as Host;

test("a permission is asked once per version of the app: an update asks again", () => {
  const once = withAsked(null, "0.6.0", "screen");
  expect(withAsked(once, "0.6.0", "screen")).toEqual({ version: "0.6.0", asked: ["screen"] });
  expect(askedIn(withAsked(once, "0.6.0", "disk"), "0.6.0")).toEqual(["screen", "disk"]);
  expect(askedIn(once, "0.6.1")).toEqual([]);
  expect(withAsked(once, "0.6.1", "network")).toEqual({ version: "0.6.1", asked: ["network"] });
});

test("states without a prompt: off once asked and not allowed, Local Network only asked or not", async () => {
  expect(await readGrants(mac(false, false), [])).toEqual({ screen: "ask", disk: "ask", network: "ask" });
  expect(await readGrants(mac(false, true), ["screen", "network"])).toEqual({
    screen: "off",
    disk: "on",
    network: "asked",
  });
  // Full Disk Access reads On before anyone asked: reading it never prompts.
  const ready = await readGrants(mac(true, true), ["network"]);
  expect(ready).toEqual({ screen: "on", disk: "on", network: "asked" });
  expect(allDone(ready)).toBe(true);
  expect(allDone({ ...ready, network: "ask" })).toBe(false);
  expect(allDone({ ...ready, disk: "off" })).toBe(false);
});

test("Full Disk Access always goes to System Settings, the others once asked", () => {
  expect(viaSettings("disk", "ask")).toBe(true);
  expect(viaSettings("screen", "ask")).toBe(false);
  expect(viaSettings("screen", "off")).toBe(true);
  expect(viaSettings("network", "ask")).toBe(false);
  expect(viaSettings("network", "asked")).toBe(true);
});
