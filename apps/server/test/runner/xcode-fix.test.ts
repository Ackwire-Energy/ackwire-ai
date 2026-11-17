import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findXcodeApp } from "../../runner/toolchains";
import { XcodeFixer, type XcodeFixOptions, xcodeFixPrompt } from "../../runner/xcode-fix";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const fixers: XcodeFixer[] = [];
afterEach(() => {
  for (const f of fixers.splice(0)) f.stop();
  removeDirs(dirs);
});

/**
 * A Mac with Xcode in `apps` and fake tools: osascript runs the script it's given as the person who typed the
 * password would (or, by `$FAKE_MODE`, cancels or waits); xcode-select, xcodebuild and xcrun log their arguments.
 */
function mac(mode = "ok", over: Partial<XcodeFixOptions> = {}) {
  const root = tempDir("xcode-fix-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  const apps = path.join(root, "Applications");
  mkdirSync(bin);
  mkdirSync(path.join(apps, "Xcode.app"), { recursive: true });
  const log = path.join(root, "log");
  const tool = (name: string, body: string) =>
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const name of ["xcode-select", "xcodebuild", "xcrun"]) tool(name, `echo "${name} $*" >> '${log}'`);
  // argv: -e … -e … -e … <script> <prompt>
  tool(
    "osascript",
    [
      `for a; do script="$prompt"; prompt="$a"; done`,
      `echo "prompt $prompt" >> '${log}'`,
      `case "$FAKE_MODE" in`,
      `  cancel) echo "0:120: execution error: User canceled. (-128)" >&2; exit 1;;`,
      `  wait) sleep 30;;`,
      `  fail) echo "0:120: execution error: xcode-select: error: invalid developer directory (1)" >&2; exit 1;;`,
      `esac`,
      `exec /bin/sh -c "$script"`,
    ].join("\n"),
  );
  const done: unknown[] = [];
  const fixer = new XcodeFixer({
    log: () => {},
    onDone: async () => {
      done.push(true);
      return undefined;
    },
    platform: "darwin",
    uid: 501,
    env: { PATH: "/usr/bin:/bin", FAKE_MODE: mode },
    apps,
    bin: (name) => path.join(bin, name),
    prompt: "agentes.chat wants to put Xcode in use to connect iPhones.",
    ...over,
  });
  fixers.push(fixer);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { fixer, calls, done, apps };
}

test("select: the password window, then Xcode in use, its license and first launch, and Xcode looked at again", async () => {
  const { fixer, calls, done, apps } = mac();
  expect(fixer.handle({ action: "start", kind: "select" }).fix).toEqual({ kind: "select", state: "asking", step: 0 });
  await waitFor(() => fixer.state()?.state === "done");
  expect(fixer.state()).toEqual({ kind: "select", state: "done", step: 3 });
  expect(calls()).toEqual([
    "prompt agentes.chat wants to put Xcode in use to connect iPhones.",
    `xcode-select -s ${path.join(apps, "Xcode.app", "Contents", "Developer")}`,
    "xcodebuild -license accept",
    "xcodebuild -runFirstLaunch",
  ]);
  await waitFor(() => done.length === 1);
});

test("every command ran yet the look after still finds Xcode blocked: failed, with why", async () => {
  const { fixer } = mac("ok", { onDone: async () => "command_line_tools" as const });
  fixer.start("select");
  await waitFor(() => fixer.state()?.state === "failed");
  expect(fixer.state()).toEqual({ kind: "select", state: "failed", step: 3, still: "command_line_tools" });
});

test("Cancel in the password window, nobody there for the timeout, a command failing: each says so", async () => {
  const canceled = mac("cancel");
  canceled.fixer.start("select");
  await waitFor(() => canceled.fixer.state()?.state === "canceled");
  expect(canceled.done).toEqual([]);

  const away = mac("wait", { askMs: 150 });
  away.fixer.start("select");
  // One at a time: asking again answers the fix under way.
  expect(away.fixer.start("select")).toEqual({ kind: "select", state: "asking", step: 0 });
  await waitFor(() => away.fixer.state()?.state === "no_answer");

  const broken = mac("fail");
  broken.fixer.start("select");
  await waitFor(() => broken.fixer.state()?.state === "failed");
  expect(broken.fixer.state()?.message).toBe("xcode-select: error: invalid developer directory (1)");

  const stopped = mac("wait");
  stopped.fixer.start("select");
  expect(stopped.fixer.handle({ action: "cancel" }).fix?.state).toBe("canceled");
  expect(stopped.fixer.handle({ action: "status" }).fix?.state).toBe("canceled");
});

test("update: devicectl's support files, no password; unsupported off a Mac, as root, or with no Xcode", async () => {
  const { fixer, calls, done } = mac();
  expect(fixer.start("update")).toEqual({ kind: "update", state: "running", step: 0 });
  await waitFor(() => fixer.state()?.state === "done");
  expect(calls()).toEqual(["xcrun devicectl manage ddis update"]);
  await waitFor(() => done.length === 1);

  expect(mac("ok", { platform: "linux" }).fixer.start("select").state).toBe("unsupported");
  expect(mac("ok", { uid: 0 }).fixer.start("select").state).toBe("unsupported");
  expect(mac("ok", { apps: path.join(tempDir("none-"), "x") }).fixer.start("select").state).toBe("unsupported");
  expect(new XcodeFixer({ log: () => {} }).handle({ action: "status" })).toEqual({ fix: null });
});

test("which Xcode, and the password window's line in the Mac's language", () => {
  const apps = tempDir("apps-");
  dirs.push(apps);
  expect(findXcodeApp(apps)).toBeNull();
  for (const name of ["Xcode_26.3.app", "Xcode_27.2.app", "Simulator.app"]) {
    mkdirSync(path.join(apps, name));
  }
  expect(findXcodeApp(apps)).toBe(path.join(apps, "Xcode_27.2.app"));
  mkdirSync(path.join(apps, "Xcode.app"));
  expect(findXcodeApp(apps)).toBe(path.join(apps, "Xcode.app"));
  expect(xcodeFixPrompt("pt-BR")).toBe("O agentes.chat quer colocar o Xcode em uso para conectar iPhones.");
  expect(xcodeFixPrompt("en-US")).toBe("agentes.chat wants to put Xcode in use to connect iPhones.");
  // The Mac's locale by its base language: any of the app's 14, English for the rest.
  expect(xcodeFixPrompt("de-DE")).toBe("agentes.chat möchte Xcode verwenden, um iPhones zu verbinden.");
  expect(xcodeFixPrompt("zh-Hans-CN")).toBe("agentes.chat 想要使用 Xcode 来连接 iPhone。");
  expect(xcodeFixPrompt("sv-SE")).toBe("agentes.chat wants to put Xcode in use to connect iPhones.");
});
