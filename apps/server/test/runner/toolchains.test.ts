import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunnerToolchains } from "@agenteschat/adapters/machine-protocol";
import { appleToolchains, cachedToolchains, probeToolchains } from "../../runner/toolchains";
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
  xcrun: "echo 26.2",
  node: "echo v24.22.1",
  podman: "echo 'podman version 5.4.2'",
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
    xcodeSdk: "26.2",
    appleTeam: "Sam Rivera (Personal Team)",
    appleAccount: "team",
    node: "24.22.1",
    podman: "5.4.2",
  });
  // Linux: no Xcode asked; without the tools, nothing said.
  const bare = computer(["git"]);
  expect(await probeToolchains({ env: bare.env, platform: "linux", home: bare.root, dirs: [] })).toEqual({
    git: "2.50.1",
  });
});

test("Xcode installed but blocked: the Command Line Tools still selected, or its license not agreed to", async () => {
  const mac = (scripts: Record<string, string>) => {
    const c = computer([]);
    for (const [name, script] of Object.entries(scripts))
      writeFileSync(path.join(c.root, "bin", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return c;
  };
  const look = (c: ReturnType<typeof computer>, apps: string) =>
    appleToolchains({
      env: c.env,
      platform: "darwin",
      home: c.root,
      dirs: [],
      apps,
      teams: async () => ({ teams: [], account: "none" }),
    });
  // Command Line Tools installed before Xcode: xcode-select never moved, so xcodebuild refuses.
  const cli = mac({
    "xcode-select": "echo /Library/Developer/CommandLineTools",
    xcodebuild:
      "echo \"xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance\" >&2; exit 1",
    xcrun: "exit 1",
  });
  const app = path.join(cli.root, "Applications");
  mkdirSync(path.join(app, "Xcode.app"), { recursive: true });
  expect(await look(cli, app)).toMatchObject({ xcode: undefined, xcodeBlocked: "command_line_tools" });
  // Only a beta or a versioned Xcode: the same one the fix would select.
  const beta = path.join(cli.root, "Beta");
  mkdirSync(path.join(beta, "Xcode-beta.app"), { recursive: true });
  expect((await look(cli, beta)).xcodeBlocked).toBe("command_line_tools");
  const versioned = path.join(cli.root, "Versioned");
  mkdirSync(path.join(versioned, "Xcode_27.2.app"), { recursive: true });
  expect((await look(cli, versioned)).xcodeBlocked).toBe("command_line_tools");
  // No Xcode at all: installing it is the step, nothing blocked.
  expect((await look(cli, path.join(cli.root, "Nowhere"))).xcodeBlocked).toBeUndefined();
  // Xcode selected, its license waiting.
  const license = mac({
    "xcode-select": "echo /Applications/Xcode.app/Contents/Developer",
    xcodebuild:
      "echo \"You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.\" >&2; exit 69",
    xcrun: "exit 69",
  });
  expect(await look(license, app)).toMatchObject({ xcode: undefined, xcodeBlocked: "license" });
  // Xcode answers: nothing blocked.
  const ready = computer(["xcode-select", "xcodebuild", "xcrun"]);
  expect(await look(ready, app)).toMatchObject({ xcode: "26.3", xcodeBlocked: undefined });
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

test("Xcode's part, looked at every minute: a team found, or Xcode updated, goes out as the whole list", async () => {
  const c = computer(["xcode-select", "xcodebuild", "xcrun"]);
  // Signed in to Xcode, no team yet: the setup's account step says so.
  expect(
    await appleToolchains({
      env: c.env,
      platform: "darwin",
      home: c.root,
      dirs: [],
      teams: async () => ({ teams: [], account: "no_team" }),
    }),
  ).toEqual({ xcode: "26.3", xcodeSdk: "26.2", appleTeam: undefined, appleAccount: "no_team" });
  expect(await appleToolchains({ env: c.env, platform: "linux", home: c.root, dirs: [] })).toEqual({});
  const file = path.join(c.root, "toolchains.json");
  writeFileSync(file, JSON.stringify({ git: "2.50.1", xcode: "26.3", appleAccount: "no_team" }));
  const told: unknown[] = [];
  let apple: RunnerToolchains = { xcode: "26.3", appleAccount: "no_team" };
  const cache = cachedToolchains(file, () => new Promise(() => {}), {
    look: async () => apple,
    onChange: (t) => told.push(t),
  });
  // The full look still running: the minute's look waits for it.
  await cache.lookApple();
  expect(told).toEqual([]);
  cache.stop();
  const quiet = cachedToolchains(file, async () => JSON.parse(readFileSync(file, "utf8")), {
    look: async () => apple,
    onChange: (t) => told.push(t),
  });
  await quiet.look();
  await quiet.lookApple();
  expect(told).toEqual([]);
  apple = { xcode: "26.3", xcodeSdk: "26.2", appleTeam: "Sam Rivera (Personal Team)", appleAccount: "team" };
  await quiet.lookApple();
  const whole = { git: "2.50.1", ...apple };
  expect(told).toEqual([whole]);
  expect(quiet.get()).toEqual(whole);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(whole);
  quiet.stop();
  // hello carried the file's last look, and the start's full look found more: the server hears it the next minute,
  // again each minute while nothing could be sent.
  writeFileSync(file, JSON.stringify({ git: "2.50.1", xcode: "26.3", appleAccount: "no_team" }));
  const sent: unknown[] = [];
  let online = false;
  const late = cachedToolchains(file, async () => whole, {
    look: async () => apple,
    onChange: (t) => online && sent.push(t) > 0,
  });
  expect(late.get()).toEqual({ git: "2.50.1", xcode: "26.3", appleAccount: "no_team" });
  await late.look();
  await late.lookApple();
  expect(sent).toEqual([]);
  online = true;
  await late.lookApple();
  await late.lookApple();
  expect(sent).toEqual([whole]);
  late.stop();
});

test("the full look finds a tool the hello didn't carry: the whole list goes out then, off a Mac too", async () => {
  const c = computer([]);
  const file = path.join(c.root, "toolchains.json");
  writeFileSync(file, JSON.stringify({ git: "2.40.0" }));
  const sent: RunnerToolchains[] = [];
  let found: RunnerToolchains = { git: "2.40.0" };
  const cache = cachedToolchains(file, async () => found, { onChange: (t) => sent.push(t) });
  expect(cache.get()).toEqual({ git: "2.40.0" });
  await cache.look();
  expect(sent).toEqual([]);
  found = { git: "2.40.0", adb: "36.0.2" };
  await cache.look();
  expect(sent).toEqual([found]);
  // No Xcode look without `look`: nothing runs each minute.
  await cache.lookApple();
  expect(sent).toHaveLength(1);
  cache.stop();
});
