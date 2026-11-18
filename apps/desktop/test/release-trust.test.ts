import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ICONS, DEFAULT_APP_ICON } from "@agenteschat/client/lib/app-icons";
import { CLOUD_SERVER } from "@agenteschat/client/lib/server";

const tauri = join(import.meta.dir, "../src-tauri");
const read = (file: string) => readFileSync(join(tauri, file), "utf8");
const config = JSON.parse(read("tauri.conf.json"));

test("desktop updates and the remote window trust Ackwire's Cloud and signing key", () => {
  expect(config.plugins.updater.endpoints).toEqual([
    `${CLOUD_SERVER}/api/desktop/update?target={{target}}&arch={{arch}}&current={{current_version}}&bundle={{bundle_type}}`,
  ]);
  expect(config.plugins.updater.pubkey).toBe(
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNDQTUxODkwRjhFMzEzQjIKUldTeUUrUDRrQmlsUFA2SllWbGtEenRiUVFvYnNmY0g0UEFwVjd2bnFkaGFGcXNQbzQ3NXFtcHUK",
  );
  expect(JSON.parse(read("capabilities/main.json")).remote.urls).toEqual([`${CLOUD_SERVER}/*`]);
  expect(read("src/servers.rs")).toContain(`pub const CLOUD: &str = "${CLOUD_SERVER}";`);
});

test("the release workflow can bump one aligned Ackwire desktop version", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  expect(pkg.version).toBe(config.version);
  expect(read("Cargo.toml").match(/^version = "([^"]+)"/m)?.[1]).toBe(config.version);
});

test("desktop accepts the same icon choices as the site, with Ackwire as the default", () => {
  const ids = [...read("src/app_icon.rs").matchAll(/icon!\("([^"]+)"\)/g)].map((m) => m[1]);
  expect(ids).toEqual([...APP_ICONS]);
  expect(ids[0]).toBe(DEFAULT_APP_ICON);
  expect(DEFAULT_APP_ICON).toBe("ackwire");
});
