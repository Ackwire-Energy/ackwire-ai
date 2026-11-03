import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isStartPage, START_PAGE_ID } from "@agenteschat/adapters/browser-start";
import { chromeLaunchArgs, domainAllowed, isWebPage } from "../../runner/browser";
import { prepareStartPage, startLocale } from "../../runner/start-page";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));
test("the offline page has no permissions or network assets and updates without replacing its manifest", () => {
  const home = tempDir("start-page-");
  dirs.push(home);
  const dir = path.join(home, "start");
  prepareStartPage(
    dir,
    { name: "<Ada>", handle: "ada" },
    { locale: "pt-BR", egress: { ip: "8.8.8.8", country: "US" } },
  );
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  expect(manifest.permissions).toBeUndefined();
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.chrome_url_overrides).toEqual({ newtab: "start.html" });
  const id = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));
  expect(id).toBe(START_PAGE_ID);
  expect(read("start.html")).toContain('aria-hidden="true"');
  expect(read("start.html")).not.toMatch(/<a\b|<button\b/);
  expect(read("start.js")).toContain('fetch("data.json"');
  expect(read("start.js")).not.toContain("https://");
  const before = statSync(path.join(dir, "manifest.json")).mtimeMs;
  prepareStartPage(dir, { name: "Ada", handle: "ada" }, { locale: "en", egress: null });
  expect(JSON.parse(read("data.json"))).toEqual({ name: "Ada", locale: "en", egress: null, flag: null });
  expect(statSync(path.join(dir, "manifest.json")).mtimeMs).toBe(before);
});
test("responsible person's language falls back to English and only the inert page is allowlisted", () => {
  expect(startLocale("pt-PT")).toBe("pt-BR");
  expect(startLocale("de")).toBe("en");
  expect(startLocale()).toBe("en");
  expect(isStartPage("chrome://newtab/")).toBe(true);
  expect(domainAllowed(`chrome-extension://${START_PAGE_ID}/start.html`, ["example.com"])).toBe(true);
  expect(domainAllowed("chrome-extension://evil/start.html", ["example.com"])).toBe(false);
  expect(isWebPage("chrome://settings/")).toBe(false);
  const args = chromeLaunchArgs("chrome", "/profile", "linux", "en", true, undefined, 0, "/readonly/start", true);
  expect(args).toContain("--load-extension=/readonly/start");
  expect(args.at(-1)).toBe("chrome://newtab/");
  expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  expect(chromeLaunchArgs("chrome", "/profile")).not.toContain(
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  );
});
