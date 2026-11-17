import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CliInstaller, type CliInstallerOptions, cliInstaller, gitBashPath } from "../../runner/cli-install";
import { CLAUDE_INSTALL_PS1_URL, CLAUDE_INSTALL_URL, CODEX_RELEASES } from "../../runner/install-script";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const installers: CliInstaller[] = [];
afterEach(() => {
  for (const i of installers.splice(0)) i.stop();
  removeDirs(dirs);
});

/** An installer that runs `script` with /bin/sh as the person would, with `found` deciding the look after it. */
function make(script: string, over: Partial<CliInstallerOptions> = {}, found = true) {
  const root = tempDir("cli-install-");
  dirs.push(root);
  const file = path.join(root, "installer.sh");
  writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const looked: string[] = [];
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: root };
  const installer = new CliInstaller({
    log: () => {},
    onDone: async (tool) => {
      looked.push(tool);
      return found;
    },
    platform: "linux",
    uid: 501,
    env,
    installer: () => ({ file: "/bin/sh", args: [file] }),
    ...over,
  });
  installers.push(installer);
  return { installer, looked, env, root };
}

test("an install runs the vendor's installer, then looks again with ~/.local/bin on the PATH, and is done", async () => {
  const { installer, looked, env, root } = make("echo installing; exit 0");
  expect(installer.handle({ action: "start", tool: "claude" }).install).toEqual({ tool: "claude", state: "running" });
  // One at a time: a second start answers the one under way.
  expect(installer.handle({ action: "start", tool: "codex" }).install).toEqual({ tool: "claude", state: "running" });
  await waitFor(() => installer.state()?.state === "done");
  expect(looked).toEqual(["claude"]);
  expect(env.PATH).toBe(`/usr/bin:/bin:${path.join(root, ".local", "bin")}`);
});

test("a failing installer ends failed with its own last line; one the look can't find, still_missing", async () => {
  const bad = make("echo 'Downloading...'; echo 'curl: (6) Could not resolve host: claude.ai' >&2; exit 6");
  bad.installer.start("claude");
  await waitFor(() => bad.installer.state()?.state === "failed");
  expect(bad.installer.state()).toEqual({
    tool: "claude",
    state: "failed",
    message: "curl: (6) Could not resolve host: claude.ai",
  });
  expect(bad.looked).toEqual([]);

  const lost = make("exit 0", {}, false);
  lost.installer.start("codex");
  await waitFor(() => lost.installer.state()?.state === "failed");
  expect(lost.installer.state()).toEqual({ tool: "codex", state: "failed", cause: "still_missing" });
});

test("cancel stops it; anything but a known program is never started", async () => {
  const { installer } = make("sleep 30");
  expect(installer.handle({ action: "start", tool: "rm -rf /" }).install).toBeNull();
  installer.start("claude");
  expect(installer.handle({ action: "cancel" }).install).toEqual({ tool: "claude", state: "canceled" });
});

test("root (system mode) and a system with no installer answer unsupported, running nothing", () => {
  expect(make("exit 0", { uid: 0 }).installer.start("claude")).toEqual({ tool: "claude", state: "unsupported" });
  const codexWindows = make("exit 0", { platform: "win32", installer: cliInstaller });
  expect(codexWindows.installer.start("codex")).toEqual({ tool: "codex", state: "unsupported" });
});

test("Claude Code on Windows without Git for Windows: said before anything is installed", () => {
  const { installer } = make("exit 0", { platform: "win32", gitBash: () => null });
  expect(installer.start("claude")).toEqual({ tool: "claude", state: "failed", cause: "git_missing" });
});

test("the installers: the vendor's address over https as an argument, never part of a script built from a request", () => {
  const mac = cliInstaller("claude", "darwin", {});
  expect(mac?.file).toBe("/bin/bash");
  expect(mac?.args.at(-1)).toBe(CLAUDE_INSTALL_URL);
  expect(mac?.args[1]).toContain("--proto '=https'");
  expect(cliInstaller("codex", "linux", {})?.args.at(-1)).toBe(CODEX_RELEASES);
  const win = cliInstaller("claude", "win32", { SystemRoot: "C:\\Windows" });
  expect(win?.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(win?.args.at(-1)).toContain(`irm '${CLAUDE_INSTALL_PS1_URL}' | iex`);
  expect(CLAUDE_INSTALL_PS1_URL.startsWith("https://")).toBe(true);
  expect(cliInstaller("codex", "win32", {})).toBeNull();
});

test("Git Bash: where CLAUDE_CODE_GIT_BASH_PATH points, beside git on the PATH, or Git for Windows' own folder", () => {
  const has = (files: string[]) => (f: string) => files.includes(f);
  expect(
    gitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\Git\\bin\\bash.exe", PATH: "" }, has(["D:\\Git\\bin\\bash.exe"])),
  ).toBe("D:\\Git\\bin\\bash.exe");
  expect(
    gitBashPath(
      { PATH: "E:\\Tools\\Git\\cmd", PATHEXT: ".EXE" },
      has(["E:\\Tools\\Git\\cmd\\git.exe", "E:\\Tools\\Git\\bin\\bash.exe"]),
    ),
  ).toBe("E:\\Tools\\Git\\bin\\bash.exe");
  expect(
    gitBashPath({ PATH: "", ProgramFiles: "C:\\Program Files" }, has(["C:\\Program Files\\Git\\bin\\bash.exe"])),
  ).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  expect(gitBashPath({ PATH: "", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\L" }, has([]))).toBeNull();
});
