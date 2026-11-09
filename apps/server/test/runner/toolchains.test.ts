import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cachedToolchains, probeToolchains } from "../../runner/toolchains";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

/** Version commands as each tool prints them (java on stderr, Maestro after an update notice). */
const TOOLS: Record<string, string> = {
  git: "echo 'git version 2.50.1 (Apple Git-155)'",
  java: `echo 'openjdk version "17.0.18" 2026-01-20 LTS' >&2`,
  adb: "printf 'Android Debug Bridge version 1.0.41\\nVersion 36.0.2-14143358\\nInstalled as x\\n'",
  scrcpy: "echo 'scrcpy 4.0 <https://github.com/Genymobile/scrcpy>'",
  maestro: "printf 'A new version is available\\n2.11.0\\n'",
  "xcode-select": "echo /Applications/Xcode.app/Contents/Developer",
  xcodebuild: "printf 'Xcode 26.3\\nBuild version 17C529\\n'",
  node: "echo v24.22.1",
};

function computer(tools: string[]) {
  const root = tempDir("toolchains-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  for (const t of tools) writeFileSync(path.join(bin, t), `#!/bin/sh\n${TOOLS[t]}\n`, { mode: 0o755 });
  return { root, env: { PATH: bin } };
}

test("what this computer builds with: each tool's version, the Android SDK's folder, nothing for what's missing", async () => {
  const c = computer(Object.keys(TOOLS));
  mkdirSync(path.join(c.root, "Library/Android/sdk"), { recursive: true });
  // The iPhone helper's signing team: the Personal Team, as Xcode names it.
  const teams = async () => [{ id: "A1B2C3D4E5", name: "Sam Rivera", free: true }];
  expect(await probeToolchains({ env: c.env, platform: "darwin", home: c.root, dirs: [], teams })).toEqual({
    git: "2.50.1",
    java: "17.0.18",
    androidSdk: path.join(c.root, "Library/Android/sdk"),
    adb: "36.0.2",
    scrcpy: "4.0",
    maestro: "2.11.0",
    xcode: "26.3",
    appleTeam: "Sam Rivera (Personal Team)",
    node: "24.22.1",
  });
  // Linux: no Xcode asked; without the tools, nothing said.
  const bare = computer(["git"]);
  expect(await probeToolchains({ env: bare.env, platform: "linux", home: bare.root, dirs: [] })).toEqual({
    git: "2.50.1",
  });
});

test("the cache: the last look at once, a fresh one written for the next hello", async () => {
  const c = computer([]);
  const file = path.join(c.root, "toolchains.json");
  writeFileSync(file, JSON.stringify({ git: "2.40.0" }));
  const cache = cachedToolchains(file, async () => ({ git: "2.50.1", node: "24.22.1" }));
  expect(cache.get()).toEqual({ git: "2.40.0" });
  await cache.look();
  expect(cache.get()).toEqual({ git: "2.50.1", node: "24.22.1" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ git: "2.50.1", node: "24.22.1" });
  cache.stop();
});
