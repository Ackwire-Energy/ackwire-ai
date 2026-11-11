import { expect, test } from "bun:test";
import { allOn, askedIn, type MacFolder, readGrants, withAsked } from "../src/control/permissions";
import type { Host } from "../src/host/types";

/** A Mac's answers: the screen, and each folder as its read finds it (a read of one never asked would prompt). */
const mac = (screen: boolean, folders: Partial<Record<MacFolder, boolean>>) => {
  const read: MacFolder[] = [];
  const host = {
    screenAccess: async () => screen,
    folderAccess: async (f: MacFolder) => {
      read.push(f);
      return folders[f] ?? false;
    },
  } as unknown as Host;
  return { host, read };
};

test("a permission is asked once per version of the app: an update asks again", () => {
  const once = withAsked(null, "0.6.0", "screen");
  expect(withAsked(once, "0.6.0", "screen")).toEqual({ version: "0.6.0", asked: ["screen"] });
  expect(askedIn(withAsked(once, "0.6.0", "desktop"), "0.6.0")).toEqual(["screen", "desktop"]);
  expect(askedIn(once, "0.6.1")).toEqual([]);
  expect(withAsked(once, "0.6.1", "desktop")).toEqual({ version: "0.6.1", asked: ["desktop"] });
});

test("states without a prompt: only folders asked for are read; the screen is off once asked and not allowed", async () => {
  const fresh = mac(false, { desktop: true });
  expect(await readGrants(fresh.host, [])).toEqual({
    screen: "ask",
    desktop: "ask",
    documents: "ask",
    downloads: "ask",
  });
  expect(fresh.read).toEqual([]);

  const asked = mac(false, { desktop: true });
  expect(await readGrants(asked.host, ["screen", "desktop", "documents"])).toEqual({
    screen: "off",
    desktop: "on",
    documents: "off",
    downloads: "ask",
  });
  expect(asked.read.sort()).toEqual(["desktop", "documents"]);

  const ready = mac(true, { desktop: true, documents: true, downloads: true });
  const grants = await readGrants(ready.host, ["desktop", "documents", "downloads"]);
  expect(grants.screen).toBe("on");
  expect(allOn(grants)).toBe(true);
  expect(allOn({ ...grants, downloads: "ask" })).toBe(false);
});
